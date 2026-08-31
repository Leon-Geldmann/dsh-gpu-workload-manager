import { Service, type Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client';
import type { SessionRuntime } from '@deepseek-ai/dsh-client-runtime/client';
import { ModelDirectory } from './model-directory.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelDirectories: ModelDirectoryResolver;
  }
}

export class ModelDirectoryResolver extends Service {
  static inject = ['connection', 'sessions', 'remote'];

  private readonly directories = new Map<SessionId, ModelDirectory>();
  private readonly blockReason: () => string;

  constructor(ctx: Context, config: { readonly blockReason: () => string }) {
    super(ctx, 'modelDirectories');
    this.blockReason = config.blockReason;
    ctx.on('connection/reset', () => {
      for (const directory of this.directories.values()) directory.resetConnected();
    });
    const refresh = (): void => {
      for (const directory of this.directories.values()) void directory.load().catch(() => undefined);
    };
    ctx.remote.$on('llm/adapters-updated', refresh);
    ctx.remote.$on('settings/document-updated', refresh);
  }

  directoryFor(sessionId: SessionId): ModelDirectory {
    const existing = this.directories.get(sessionId);
    if (existing !== undefined) return existing;
    const sessions = this.ctx.get('sessions') as SessionRuntime;
    const sessionScope = sessions.scope(sessionId);
    if (sessionScope === undefined) throw new Error(`gpu-model-selection: session "${String(sessionId)}" resolved no scope`);
    const connection = this.ctx.get('connection') as ConnectionHandle;
    const directory = new ModelDirectory(
      connection.api.sessions,
      sessionId,
      () => sessions.subagentAddress(sessionId) === undefined,
    );
    this.directories.set(sessionId, directory);

    const conversation = this.ctx.get('conversation');
    if (conversation !== undefined) {
      const publishBlock = (): void => {
        conversation.blocks.set(
          sessionId,
          directory.store.getSnapshot().routable === false ? { reason: this.blockReason() } : undefined,
        );
      };
      publishBlock();
      sessionScope.effect(() => {
        const unsubscribe = directory.store.subscribe(publishBlock);
        return () => {
          unsubscribe();
          conversation.blocks.set(sessionId, undefined);
        };
      }, 'gpu-model-selection: composer block');
    }

    sessionScope.effect(() => () => {
      directory.dispose();
      this.directories.delete(sessionId);
    }, 'gpu-model-selection: session directory');
    return directory;
  }
}
