import type {
  IApiClient,
  ModelCatalogFailure,
  ModelProviderGroup,
  ModelSelection,
  SessionId,
  SessionModels,
} from '@deepseek-ai/dsh-api-remotes/client';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';

export interface ModelDirectoryState {
  current: ModelSelection | null;
  routable: boolean | null;
  groups: readonly ModelProviderGroup[];
  failures: readonly ModelCatalogFailure[];
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error';
  error: string | null;
}

function createStore<T extends object>(initial: T): SnapshotStore<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const publish = (): void => { for (const listener of listeners) listener(); };
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

export class ModelDirectory {
  readonly store: SnapshotStore<ModelDirectoryState> = createStore<ModelDirectoryState>({
    current: null,
    routable: null,
    groups: [],
    failures: [],
    status: 'idle',
    error: null,
  });

  private generation = 0;
  private disposed = false;

  constructor(
    private readonly sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
  ) {}

  async load(): Promise<SessionModels> {
    this.assertAvailable();
    const generation = ++this.generation;
    this.store.update((state) => { state.status = 'loading'; state.error = null; });
    const { result } = await this.sessions.models({ sessionId: this.sessionId });
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      return result.value;
    }
    if (!result.ok) {
      this.store.update((state) => {
        state.status = 'error';
        state.error = `${result.error.code}: ${result.error.message}`;
      });
      throw new Error(`session.models failed: ${result.error.code}: ${result.error.message}`);
    }
    this.publish(result.value);
    return result.value;
  }

  async select(selection: ModelSelection): Promise<void> {
    this.assertAvailable();
    const generation = ++this.generation;
    this.store.update((state) => { state.status = 'selecting'; state.error = null; });
    const { result } = await this.sessions.selectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    });
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      return;
    }
    if (!result.ok) {
      this.store.update((state) => {
        state.status = 'error';
        state.error = `${result.error.code}: ${result.error.message}`;
      });
      throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`);
    }
    this.store.update((state) => {
      state.current = result.value.selected;
      state.routable = true;
      state.status = 'ready';
      state.error = null;
    });
  }

  resetConnected(): void {
    if (this.disposed) return;
    ++this.generation;
    this.store.set({
      current: null,
      routable: null,
      groups: [],
      failures: [],
      status: 'idle',
      error: null,
    });
    if (this.available()) void this.load().catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
  }

  private publish(directory: SessionModels): void {
    this.store.update((state) => {
      state.current = directory.current;
      state.routable = directory.routable;
      state.groups = directory.groups;
      state.failures = directory.failures;
      state.status = 'ready';
      state.error = null;
    });
  }

  private assertAvailable(): void {
    if (!this.available()) throw new Error('model selection is unavailable for addressed subagent sessions');
  }
}
