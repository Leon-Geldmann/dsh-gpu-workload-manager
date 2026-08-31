import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type {
  GpuCancelResult,
  GpuManagerStatus,
  GpuModel,
  GpuModelList,
  GpuOperationRequest,
  GpuSubmitResult,
  LocalModelId,
} from '@local/dsh-gpu-workload-manager/types';
import type { ManualAction } from './GpuManagerDialog.js';

export interface BrowserGpuRemote {
  status(signal?: AbortSignal): Promise<RemoteResult<GpuManagerStatus>>;
  models(signal?: AbortSignal): Promise<RemoteResult<GpuModelList>>;
  submit(request: GpuOperationRequest, signal?: AbortSignal): Promise<RemoteResult<GpuSubmitResult>>;
  cancel(operationId: string, signal?: AbortSignal): Promise<RemoteResult<GpuCancelResult>>;
}

export interface BusyChoiceState {
  readonly action: 'load' | 'switch' | 'unload';
  readonly model?: LocalModelId;
  readonly activeRequestCount: number;
  readonly activeModel?: LocalModelId;
  readonly targetModel?: LocalModelId;
}

export interface GpuManagerViewState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  status: GpuManagerStatus | null;
  models: readonly GpuModel[];
  pending: boolean;
  busy: BusyChoiceState | null;
  error: string | null;
  openSession: string | null;
}

export interface GpuManagerControllerOptions {
  readonly uuid?: () => string;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
  readonly selectResidentModel?: (sessionId: string, model: LocalModelId) => Promise<void>;
}

const SAFE_ERROR = 'GPU Workload Manager 暂不可用';

function createControllerStore<T extends object>(initial: T): SnapshotStore<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(mutator) {
      const next = { ...snapshot };
      mutator(next);
      snapshot = next;
      publish();
    },
    set(next) {
      snapshot = next;
      publish();
    },
  };
}

export class GpuManagerController {
  readonly store: SnapshotStore<GpuManagerViewState> = createControllerStore<GpuManagerViewState>({
    phase: 'idle', status: null, models: [], pending: false, busy: null, error: null, openSession: null,
  });
  private readonly remote: BrowserGpuRemote;
  private readonly uuid: () => string;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly selectResidentModel: ((sessionId: string, model: LocalModelId) => Promise<void>) | undefined;
  private readonly lifetime = new AbortController();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollGeneration = 0;
  private pollingActive = false;
  private pollRetriesRemaining: number;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private statusWatchers = 0;
  private statusWatchGeneration = 0;
  private disposed = false;
  private refreshLock: Promise<void> | undefined;
  private refreshSequence = 0;
  private transitionPollingRequired = false;
  private pendingResidentSelection: {
    readonly sessionId: string;
    readonly model: LocalModelId;
    readonly installedAfterRefresh: number;
  } | undefined;

  constructor(remote: BrowserGpuRemote, options: GpuManagerControllerOptions = {}) {
    this.remote = remote;
    this.uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.maxPolls = options.maxPolls ?? 600;
    this.pollRetriesRemaining = this.maxPolls;
    this.selectResidentModel = options.selectResidentModel;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1 || !Number.isSafeInteger(this.maxPolls) || this.maxPolls < 1) {
      throw new Error('invalid_gpu_manager_controller_options');
    }
  }

  open(sessionId: string): void {
    if (this.disposed) return;
    this.store.update((state) => { state.openSession = sessionId; });
  }

  close(sessionId: string): void {
    if (this.store.getSnapshot().openSession !== sessionId) return;
    this.store.update((state) => { state.openSession = null; state.busy = null; });
  }

  async refresh(followTransitions = true, canStart: () => boolean = () => true): Promise<GpuManagerStatus | null> {
    while (this.refreshLock !== undefined) await this.refreshLock;
    if (this.disposed || !canStart()) return null;
    const lock = Promise.withResolvers<void>();
    this.refreshLock = lock.promise;
    const refreshSequence = ++this.refreshSequence;
    try {
      const resumePolling = followTransitions && (this.pollingActive || shouldPoll(this.store.getSnapshot().status));
      if (followTransitions) {
        this.stopPolling();
        if (resumePolling) this.transitionPollingRequired = true;
      }
      this.store.update((state) => { state.phase = 'loading'; state.error = null; });
      try {
        const [statusResult, modelsResult] = await Promise.all([
          this.remote.status(this.lifetime.signal),
          this.remote.models(this.lifetime.signal),
        ]);
        if (this.disposed) return null;
        const status = unwrap(statusResult);
        const models = unwrap(modelsResult);
        this.store.update((state) => {
          state.phase = 'ready';
          state.status = status;
          state.models = [...models.data];
          state.error = null;
        });
        await this.commitResidentSelection(status, refreshSequence);
        if (!this.disposed && shouldPoll(status) && (followTransitions || this.transitionPollingRequired)) {
          this.transitionPollingRequired = false;
          this.startPolling(this.maxPolls);
        } else if (!shouldPoll(status)) {
          this.transitionPollingRequired = false;
        }
        return status;
      } catch {
        if (this.disposed) return null;
        this.store.update((state) => { state.phase = 'error'; state.error = SAFE_ERROR; });
        if (this.transitionPollingRequired) {
          this.transitionPollingRequired = false;
          this.startPolling(this.pollRetriesRemaining);
        }
        return null;
      }
    } finally {
      if (this.refreshLock === lock.promise) this.refreshLock = undefined;
      lock.resolve();
    }
  }

  async submit(action: ManualAction): Promise<void> {
    if (this.disposed || this.store.getSnapshot().pending) return;
    const initiatingSession = this.store.getSnapshot().openSession;
    this.store.update((state) => { state.pending = true; state.error = null; });
    const request: GpuOperationRequest = action.action === 'unload'
      ? { idempotencyKey: this.uuid(), action: 'unload', onBusy: action.onBusy }
      : { idempotencyKey: this.uuid(), action: action.action, model: action.model!, onBusy: action.onBusy };
    try {
      const result = unwrap(await this.remote.submit(request, this.lifetime.signal));
      if (this.disposed) return;
      if (result.kind === 'busy') {
        this.store.update((state) => {
          state.busy = {
            action: action.action,
            ...(action.model === undefined ? {} : { model: action.model }),
            activeRequestCount: result.activeRequestCount,
            ...(result.activeModel === undefined ? {} : { activeModel: result.activeModel }),
            ...(result.targetModel === undefined ? {} : { targetModel: result.targetModel }),
          };
        });
      } else if (result.kind === 'conflict') {
        this.store.update((state) => { state.error = result.code === 'operation_in_progress' ? '另一个 GPU 操作正在进行' : SAFE_ERROR; });
      } else {
        this.stopPolling();
        this.transitionPollingRequired = true;
        if (action.action !== 'unload' && action.model !== undefined && initiatingSession !== null) {
          this.pendingResidentSelection = Object.freeze({
            sessionId: initiatingSession,
            model: action.model,
            installedAfterRefresh: this.refreshSequence,
          });
        }
        this.store.update((state) => { state.busy = null; });
        await this.refresh(false);
        if (!this.pollingActive) this.startPolling(this.maxPolls);
      }
    } catch {
      if (!this.disposed) this.store.update((state) => { state.error = SAFE_ERROR; });
    } finally {
      if (!this.disposed) this.store.update((state) => { state.pending = false; });
    }
  }

  async resolveBusy(policy: 'queue' | 'force'): Promise<void> {
    const busy = this.store.getSnapshot().busy;
    if (busy === null) return;
    await this.submit({ action: busy.action, ...(busy.model === undefined ? {} : { model: busy.model }), onBusy: policy });
  }

  async cancel(operationId: string): Promise<void> {
    if (this.disposed || this.store.getSnapshot().pending) return;
    this.store.update((state) => { state.pending = true; state.error = null; });
    try {
      const result = unwrap(await this.remote.cancel(operationId, this.lifetime.signal));
      if (this.disposed) return;
      if (result.kind === 'conflict') {
        this.store.update((state) => { state.error = result.code === 'operation_not_cancellable' ? '当前操作已经无法取消' : '找不到要取消的操作'; });
      } else {
        await this.refresh();
      }
    } catch {
      if (!this.disposed) this.store.update((state) => { state.error = SAFE_ERROR; });
    } finally {
      if (!this.disposed) this.store.update((state) => { state.pending = false; });
    }
  }

  watchStatus(): () => void {
    if (this.disposed) return () => undefined;
    this.statusWatchers += 1;
    if (this.statusWatchers === 1) this.runStatusWatch(++this.statusWatchGeneration);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.statusWatchers = Math.max(0, this.statusWatchers - 1);
      if (this.statusWatchers === 0) {
        this.statusWatchGeneration += 1;
        if (this.watchTimer !== undefined) clearTimeout(this.watchTimer);
        this.watchTimer = undefined;
      }
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingResidentSelection = undefined;
    this.transitionPollingRequired = false;
    this.statusWatchers = 0;
    this.statusWatchGeneration += 1;
    if (this.watchTimer !== undefined) clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    this.stopPolling();
    this.lifetime.abort();
  }

  private startPolling(errorRetriesRemaining: number): void {
    this.stopPolling();
    if (this.disposed || errorRetriesRemaining <= 0) return;
    this.transitionPollingRequired = false;
    this.pollingActive = true;
    this.pollRetriesRemaining = errorRetriesRemaining;
    const generation = this.pollGeneration;
    this.pollTimer = setTimeout(() => {
      if (generation !== this.pollGeneration || !this.pollingActive) return;
      this.pollTimer = undefined;
      void this.refresh(false, () => generation === this.pollGeneration && this.pollingActive).then((status) => {
        if (this.disposed || generation !== this.pollGeneration || !this.pollingActive) return;
        const snapshot = this.store.getSnapshot();
        if (status === null || snapshot.phase === 'error') {
          this.startPolling(errorRetriesRemaining - 1);
        } else if (shouldPoll(status)) {
          // maxPolls is a consecutive transport-error budget, not a cap on a
          // valid DRAINING/STARTING transition that may legitimately take hours.
          this.startPolling(this.maxPolls);
        } else {
          this.stopPolling();
        }
      });
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    this.pollGeneration += 1;
    this.pollingActive = false;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private runStatusWatch(generation: number): void {
    if (this.disposed || this.statusWatchers === 0 || generation !== this.statusWatchGeneration) return;
    const active = () => !this.disposed && this.statusWatchers > 0 && generation === this.statusWatchGeneration;
    void this.refresh(false, active).finally(() => {
      if (this.disposed || this.statusWatchers === 0 || generation !== this.statusWatchGeneration) return;
      this.watchTimer = setTimeout(() => {
        this.watchTimer = undefined;
        this.runStatusWatch(generation);
      }, this.pollIntervalMs);
    });
  }

  private async commitResidentSelection(status: GpuManagerStatus, refreshSequence: number): Promise<void> {
    const pending = this.pendingResidentSelection;
    if (pending === undefined) return;
    // A watcher or foreground refresh can have started before submit() was
    // accepted and complete afterward. Its terminal snapshot must not consume
    // selection work created by the newer accepted operation.
    if (refreshSequence <= pending.installedAfterRefresh) return;
    if (status.phase === 'READY' && status.activeModel === pending.model) {
      this.pendingResidentSelection = undefined;
      if (this.selectResidentModel === undefined) return;
      try {
        await this.selectResidentModel(pending.sessionId, pending.model);
      } catch {
        if (!this.disposed) this.store.update((state) => { state.error = '模型已装载，但当前会话切换失败'; });
      }
      return;
    }
    if (!shouldPoll(status) && status.activeOperation === undefined) this.pendingResidentSelection = undefined;
  }
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error('remote_failure');
  return result.value;
}

function shouldPoll(status: GpuManagerStatus | null): boolean {
  if (status === null) return false;
  if (status.activeOperation?.status === 'QUEUED' || status.activeOperation?.status === 'RUNNING') return true;
  return status.phase === 'STARTING' || status.phase === 'WARMING' || status.phase === 'DRAINING' || status.phase === 'FORCING' || status.phase === 'STOPPING';
}
