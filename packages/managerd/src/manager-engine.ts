import type { ManagerPhase, ModelSpec, OperationRequest } from '@local/gpu-workload-core';
import { OperationStore, type ManagedOperationSnapshot } from './operation-store.js';
import { RequestRegistry, type AdmissionResult } from './request-registry.js';
import type { RunningChild, UnexpectedChildExit } from './child-supervisor.js';
import type { WorkloadTelemetry } from './metrics.js';

export interface LifecycleSupervisor {
  start(model: ModelSpec): Promise<RunningChild>;
  stop(reason: string): Promise<void>;
  onUnexpectedExit(listener: (event: UnexpectedChildExit) => void): () => void;
}
export type ChildExitEvent = UnexpectedChildExit;

export interface EngineSnapshot {
  readonly phase: ManagerPhase;
  readonly activeModel?: string;
  readonly activeOperation?: ManagedOperationSnapshot;
  readonly activeRequestCount: number;
  readonly target?: string;
}

export type SubmitResult =
  | { readonly kind: 'accepted' | 'noop'; readonly operation: ManagedOperationSnapshot }
  | { readonly kind: 'busy'; readonly code: 'local_model_busy'; readonly activeRequestCount: number; readonly activeModel?: string; readonly target?: string }
  | { readonly kind: 'conflict'; readonly code: 'idempotency_conflict' | 'operation_in_progress' }
  | { readonly kind: 'unavailable'; readonly code: 'manager_shutting_down' };

export type CancelResult = { readonly kind: 'cancelled'; readonly operation: ManagedOperationSnapshot } | { readonly kind: 'conflict'; readonly code: 'operation_not_cancellable' | 'operation_not_found' };

export interface ManagerEngineOptions {
  readonly catalog: readonly ModelSpec[];
  readonly supervisor: LifecycleSupervisor;
  /** Accepted for migration compatibility, but deliberately ignored on every startup. */
  readonly persistedActiveModel?: string;
  readonly operationStore?: OperationStore;
  readonly transitionScheduler?: { beforeDrainCommit(operationId: string): Promise<void> };
  readonly drainTimeoutMs?: number;
  readonly telemetry?: Pick<WorkloadTelemetry, 'observeQueueWait' | 'addForceCancellations'>;
  readonly now?: () => number;
}

/** Single-process coordinator. All state checks and writes in submit/admit are synchronous. */
export class ManagerEngine {
  #phase: ManagerPhase = 'UNLOADED';
  #activeModel?: string;
  #activeOperationId?: string;
  #target?: string;
  #generation = 0;
  #settled = new Set<Promise<void>>();
  #catalog: ReadonlyMap<string, ModelSpec>;
  #registry = new RequestRegistry({ maximumActive: 1 });
  #store: OperationStore;
  #running?: RunningChild;
  #unsubscribe: () => void;
  #shutdownPromise?: Promise<void>;
  #shuttingDown = false;
  #drainTimer?: NodeJS.Timeout;
  #drainTimeoutMs: number;
  #queueStartedAt?: number;
  #queueModel?: string;

  constructor(private readonly options: ManagerEngineOptions) {
    this.#catalog = new Map(options.catalog.map((model) => [model.id, Object.freeze({ ...model })]));
    if (this.#catalog.size !== options.catalog.length) throw new Error('invalid_catalog');
    this.#store = options.operationStore ?? new OperationStore();
    this.#drainTimeoutMs = options.drainTimeoutMs ?? 2 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.#drainTimeoutMs) || this.#drainTimeoutMs < 1) throw new Error('invalid_drain_timeout');
    this.#unsubscribe = options.supervisor.onUnexpectedExit((event) => this.#onUnexpectedExit(event));
    // Do not consult persistedActiveModel: restart is always genuinely unloaded.
  }

  snapshot(): EngineSnapshot {
    const activeOperation = this.#activeOperationId === undefined ? undefined : this.#store.get(this.#activeOperationId);
    return Object.freeze({ phase: this.#phase, ...(this.#activeModel === undefined ? {} : { activeModel: this.#activeModel }), ...(activeOperation === undefined ? {} : { activeOperation }), activeRequestCount: this.#registry.count(), ...(this.#target === undefined ? {} : { target: this.#target }) });
  }
  operations(): readonly ManagedOperationSnapshot[] { return this.#store.all(); }
  configureDrainTimeout(timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || this.#activeOperationId !== undefined) throw new Error('invalid_drain_timeout');
    this.#drainTimeoutMs = timeoutMs;
  }
  whenSettled(): Promise<void> { return Promise.allSettled([...this.#settled]).then(() => undefined); }

  submit(request: OperationRequest, _source: string): Promise<SubmitResult> {
    // This method intentionally contains no await: idempotency, arbitration, busy inspection,
    // phase transition and admission closure all linearize in this same JavaScript turn.
    if (this.#shuttingDown) return Promise.resolve(Object.freeze({ kind: 'unavailable', code: 'manager_shutting_down' }));
    const claim = this.#store.claim(request);
    if (claim.kind === 'conflict') return Promise.resolve(Object.freeze({ kind: 'conflict', code: 'idempotency_conflict' }));
    if (claim.kind === 'replay') return Promise.resolve(this.#store.initialResult(claim.operation.id) as SubmitResult);
    const operation = claim.operation;

    if (this.#activeOperationId !== undefined) {
      // The fresh record is terminalized so future retries remain a stable conflict, rather
      // than leaving an active record that could never execute.
      this.#store.finish(operation.id, 'FAILED', { code: 'operation_in_progress' });
      return Promise.resolve(this.#remember(operation.id, Object.freeze({ kind: 'conflict', code: 'operation_in_progress' })));
    }
    const target = targetFor(request);
    if (this.#isNoop(request)) {
      const completed = this.#store.finish(operation.id, 'COMPLETED', undefined, this.#activeModel === undefined ? undefined : { activeModel: this.#activeModel });
      return Promise.resolve(this.#remember(operation.id, Object.freeze({ kind: 'noop', operation: completed })));
    }
    const busy = this.#registry.count();
    if (busy > 0 && request.onBusy === 'reject') {
      this.#store.finish(operation.id, 'FAILED', { code: 'local_model_busy' });
      return Promise.resolve(this.#remember(operation.id, Object.freeze({ kind: 'busy', code: 'local_model_busy', activeRequestCount: busy, ...(this.#activeModel === undefined ? {} : { activeModel: this.#activeModel }), ...(target === undefined ? {} : { target }) })));
    }

    this.#activeOperationId = operation.id;
    this.#target = target;
    const generation = ++this.#generation;
    if (busy > 0 && request.onBusy === 'queue') {
      this.#phase = 'DRAINING';
      this.#queueStartedAt = this.#now();
      this.#queueModel = target ?? this.#activeModel;
      this.#startDrainDeadline(operation.id, generation);
      const idle = this.#registry.closeAdmissionAndWhenIdle();
      this.#store.setStatus(operation.id, 'QUEUED');
      this.#launch(this.#afterDrain(operation.id, request, generation, idle));
      return Promise.resolve(this.#remember(operation.id, Object.freeze({ kind: 'accepted', operation: this.#store.get(operation.id)! })));
    }
    if (busy > 0 && request.onBusy === 'force') {
      this.#phase = 'FORCING';
      this.#registry.closeAdmission();
      const residentModel = this.#activeModel;
      if (residentModel !== undefined) this.#observe(() => this.options.telemetry?.addForceCancellations(residentModel, busy));
      this.#registry.abortAll();
    } else {
      this.#registry.closeAdmission();
    }
    this.#launch(this.#runLifecycle(operation.id, request, generation));
    return Promise.resolve(this.#remember(operation.id, Object.freeze({ kind: 'accepted', operation: this.#store.get(operation.id)! })));
  }

  cancel(operationId: string): CancelResult {
    if (this.#activeOperationId !== operationId || this.#phase !== 'DRAINING') {
      return Object.freeze({ kind: 'conflict', code: this.#store.get(operationId) === undefined ? 'operation_not_found' : 'operation_not_cancellable' });
    }
    // This is the cancellation commit point. A later zero waiter has a different generation.
    ++this.#generation;
    this.#finishQueueWait();
    this.#clearDrainDeadline();
    this.#activeOperationId = undefined;
    this.#target = undefined;
    this.#phase = this.#activeModel === undefined ? 'UNLOADED' : 'READY';
    this.#registry.openAdmission();
    const operation = this.#store.finish(operationId, 'CANCELLED');
    return Object.freeze({ kind: 'cancelled', operation });
  }

  admitInference(model: string): AdmissionResult {
    if (this.#phase !== 'READY') return Object.freeze({ kind: 'rejected', code: 'model_transition' });
    if (this.#activeModel !== model) return Object.freeze({ kind: 'rejected', code: 'model_transition' });
    return this.#registry.admit(model);
  }
  completeInference(requestId: string): void {
    this.#registry.complete(requestId);
  }
  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    const completion = Promise.withResolvers<void>();
    this.#shutdownPromise = completion.promise;
    this.#shuttingDown = true;
    try {
      const ownedWork = Promise.allSettled([...this.#settled]);
      this.#registry.shutdown(); ++this.#generation;
      this.#finishQueueWait();
      this.#clearDrainDeadline();
      if (this.#activeOperationId !== undefined) this.#store.finish(this.#activeOperationId, 'FAILED', { code: 'manager_shutdown' });
      this.#activeOperationId = undefined; this.#target = undefined; this.#phase = 'STOPPING';
      void (async () => {
        try { await ownedWork; await this.options.supervisor.stop('manager_shutdown'); this.#running = undefined; this.#activeModel = undefined; this.#phase = 'UNLOADED'; }
        catch (error) { this.#phase = 'FAILED'; throw error; }
        finally { this.#unsubscribe(); }
      })().then(completion.resolve, completion.reject);
    } catch (error) {
      this.#phase = 'FAILED';
      this.#unsubscribe();
      completion.reject(error);
    }
    return this.#shutdownPromise;
  }

  #replayResult(operation: ManagedOperationSnapshot): SubmitResult {
    if (operation.error?.code === 'idempotency_conflict') return Object.freeze({ kind: 'conflict', code: 'idempotency_conflict' });
    if (operation.error?.code === 'operation_in_progress') return Object.freeze({ kind: 'conflict', code: 'operation_in_progress' });
    if (operation.error?.code === 'local_model_busy') return Object.freeze({ kind: 'busy', code: 'local_model_busy', activeRequestCount: this.#registry.count(), ...(this.#activeModel === undefined ? {} : { activeModel: this.#activeModel }), ...(targetFor(operation.request) === undefined ? {} : { target: targetFor(operation.request) }) });
    return Object.freeze({ kind: operation.status === 'COMPLETED' && this.#isNoop(operation.request) ? 'noop' : 'accepted', operation });
  }
  #remember<T extends SubmitResult>(id: string, result: T): T { this.#store.setInitialResult(id, result); return result; }
  #launch(work: Promise<void>): void {
    this.#settled.add(work);
    void work.then(
      () => this.#settled.delete(work),
      () => this.#settled.delete(work),
    );
  }
  async #afterDrain(id: string, request: OperationRequest, generation: number, idle: Promise<void>): Promise<void> {
    await idle;
    this.#finishQueueWait();
    await this.options.transitionScheduler?.beforeDrainCommit(id);
    if (!this.#owns(id, generation) || this.#phase !== 'DRAINING') return;
    await this.#runLifecycle(id, request, generation);
  }
  async #runLifecycle(id: string, request: OperationRequest, generation: number): Promise<void> {
    if (!this.#owns(id, generation)) return;
    this.#store.setStatus(id, 'RUNNING');
    const previous = this.#activeModel;
    try {
      if (previous !== undefined) {
        this.#phase = 'STOPPING';
        await this.options.supervisor.stop(request.action === 'unload' ? 'unload' : 'model_transition');
        if (!this.#owns(id, generation)) return;
        this.#activeModel = undefined;
      }
      if (request.action === 'unload') {
        this.#finishSuccess(id, generation, undefined);
        return;
      }
      const target = this.#model(request.model);
      this.#phase = 'STARTING';
      try {
        this.#running = await this.options.supervisor.start(target);
      } catch (error) {
        if (!this.#owns(id, generation)) return;
        await this.#rollback(id, generation, previous, error);
        return;
      }
      if (!this.#owns(id, generation)) return;
      // ChildSupervisor resolves start only after its readiness/warm-up boundary. Keep a
      // visible WARMING transition for supervisors which report it asynchronously.
      this.#phase = 'WARMING';
      this.#activeModel = target.id;
      this.#finishSuccess(id, generation, target.id);
    } catch (error) {
      if (!this.#owns(id, generation)) return;
      this.#activeModel = undefined;
      this.#phase = 'FAILED';
      this.#finishFailure(id, generation, 'lifecycle_failed');
    }
  }
  async #rollback(id: string, generation: number, previous: string | undefined, _targetError: unknown): Promise<void> {
    if (previous === undefined) {
      this.#activeModel = undefined;
      this.#phase = 'FAILED';
      this.#finishFailure(id, generation, 'target_start_failed');
      return;
    }
    try {
      this.#phase = 'STARTING';
      this.#running = await this.options.supervisor.start(this.#model(previous));
      if (!this.#owns(id, generation)) return;
      this.#phase = 'WARMING';
      this.#activeModel = previous;
      this.#phase = 'READY';
      this.#finishFailure(id, generation, 'target_start_failed');
    } catch {
      if (!this.#owns(id, generation)) return;
      this.#activeModel = undefined;
      this.#phase = 'DEGRADED_UNLOADED';
      this.#finishFailure(id, generation, 'rollback_start_failed');
    }
  }
  #finishSuccess(id: string, generation: number, activeModel: string | undefined): void {
    if (!this.#owns(id, generation)) return;
    this.#phase = activeModel === undefined ? 'UNLOADED' : 'READY';
    this.#target = undefined;
    this.#activeOperationId = undefined;
    this.#store.finish(id, 'COMPLETED', undefined, activeModel === undefined ? undefined : { activeModel });
    this.#registry.openAdmission();
    this.#clearDrainDeadline();
  }
  #finishFailure(id: string, generation: number, code: string): void {
    if (!this.#owns(id, generation)) return;
    this.#target = undefined;
    this.#activeOperationId = undefined;
    this.#store.finish(id, 'FAILED', { code }, this.#activeModel === undefined ? undefined : { activeModel: this.#activeModel });
    if (this.#phase === 'READY') this.#registry.openAdmission();
    this.#clearDrainDeadline();
  }
  #startDrainDeadline(id: string, generation: number): void {
    this.#clearDrainDeadline();
    this.#drainTimer = setTimeout(() => {
      if (!this.#owns(id, generation) || this.#phase !== 'DRAINING') return;
      this.#finishQueueWait();
      ++this.#generation; this.#activeOperationId = undefined; this.#target = undefined;
      this.#phase = this.#activeModel === undefined ? 'UNLOADED' : 'READY';
      this.#store.finish(id, 'FAILED', { code: 'drain_timeout' }, this.#activeModel === undefined ? undefined : { activeModel: this.#activeModel });
      this.#registry.openAdmission(); this.#clearDrainDeadline();
    }, this.#drainTimeoutMs);
    this.#drainTimer.unref();
  }
  #clearDrainDeadline(): void { if (this.#drainTimer !== undefined) { clearTimeout(this.#drainTimer); this.#drainTimer = undefined; } }
  #finishQueueWait(): void {
    const startedAt = this.#queueStartedAt; const model = this.#queueModel;
    this.#queueStartedAt = undefined; this.#queueModel = undefined;
    if (startedAt !== undefined && model !== undefined) this.#observe(() => this.options.telemetry?.observeQueueWait(model, Math.max(0, this.#now() - startedAt) / 1_000));
  }
  #observe(callback: () => void): void { try { callback(); } catch { /* telemetry must not alter workload state */ } }
  #now(): number { return this.options.now?.() ?? performance.now(); }
  #owns(id: string, generation: number): boolean { return this.#activeOperationId === id && this.#generation === generation; }
  #model(id: string | undefined): ModelSpec { if (id === undefined || this.#catalog.get(id) === undefined) throw new Error('invalid_model_id'); return this.#catalog.get(id)!; }
  #isNoop(request: OperationRequest): boolean { return (request.action === 'unload' && this.#activeModel === undefined) || ((request.action === 'load' || request.action === 'switch') && request.model === this.#activeModel); }
  #onUnexpectedExit(event: UnexpectedChildExit): void {
    if (this.#running === undefined || !sameChild(this.#running, event.child)) return;
    ++this.#generation;
    this.#finishQueueWait();
    this.#clearDrainDeadline();
    const operationId = this.#activeOperationId;
    this.#activeOperationId = undefined;
    this.#registry.closeAdmission();
    this.#running = undefined;
    this.#activeModel = undefined;
    this.#target = undefined;
    this.#phase = 'FAILED';
    if (operationId !== undefined) this.#store.finish(operationId, 'FAILED', { code: 'child_exited' });
    this.#registry.abortAll();
  }
}

function targetFor(request: OperationRequest): string | undefined { return request.action === 'unload' ? undefined : request.model; }
function sameChild(a: RunningChild, b: RunningChild): boolean { return a.pid === b.pid && a.startToken === b.startToken && a.model === b.model; }
