import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ModelSelection, SessionId, SessionModels } from '@deepseek-ai/dsh-api-remotes/client';
import type { ClientContext, ISessions, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { CommandUiContract, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import gpuRemote from '@local/dsh-gpu-workload-manager/remote';
import { GpuManagerDialog } from './GpuManagerDialog.js';
import { GpuModelSelect, type ModelOption } from './GpuModelSelect.js';
import { GpuManagerController, type GpuManagerViewState } from './manager-controller.js';
import type { ModelDirectoryState } from './model-directory.js';
import { ModelDirectoryResolver } from './model-directory-service.js';
import { en, zh, type GpuModelLocaleKey } from './locales.js';
import { LOCAL_PROVIDER_ID, modelPolicy, type ManagerAvailability } from './policy.js';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    gpuModel: GpuModelLocaleKey;
  }
}

const NS = 'gpuModel';

export interface GpuModelSeatInjected {
  readonly available: boolean;
  readonly directory: SnapshotStore<ModelDirectoryState>;
  readonly manager: GpuManagerController;
  readonly load: () => void;
  readonly select: (selection: ModelSelection) => Promise<boolean>;
  readonly openManager: () => void;
}

export interface GpuManagerHostInjected {
  readonly manager: GpuManagerController;
}

interface DirectoryCatalog {
  readonly current: ModelSelection | null;
  readonly groups: readonly SessionModels['groups'][number][];
  readonly failures: readonly SessionModels['failures'][number][];
}

export function modelOptions(directory: DirectoryCatalog): ModelOption[] {
  const options: ModelOption[] = [];
  for (const group of directory.groups) {
    for (const model of group.models) {
      options.push({
        providerId: group.id,
        id: model.id,
        label: model.name,
        detail: model.description === undefined ? group.name : `${group.name} · ${model.description}`,
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      });
    }
  }
  return options;
}

export function selectionForOption(state: Pick<ModelDirectoryState, 'current' | 'groups'>, id: string): ModelSelection | undefined {
  for (const group of state.groups) {
    for (const model of group.models) {
      if (rowId(group.id, model.id) !== id) continue;
      const sameRoute = state.current?.provider === group.id && state.current.model === model.id;
      const reasoningEffort = sameRoute
        ? state.current?.reasoningEffort ?? model.reasoning?.defaultEffort
        : model.reasoning?.defaultEffort;
      return {
        provider: group.id,
        model: model.id,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      };
    }
  }
  return undefined;
}

function popupOptions(directory: SessionModels): SelectOption[] {
  const options = modelOptions(directory).map((option) => ({
    id: rowId(option.providerId, option.id),
    label: option.label,
    ...(option.detail === undefined ? {} : { detail: option.detail }),
    ...(directory.current.provider === option.providerId && directory.current.model === option.id ? { active: true } : {}),
  }));
  for (const failure of directory.failures) {
    options.push({
      id: `failure/${failure.id}`,
      label: failure.name,
      detail: `目录加载失败：${failure.message}`,
    });
  }
  return options;
}

function availabilityFromState(state: GpuManagerViewState): ManagerAvailability | null {
  const status = state.status;
  if (state.phase !== 'ready' || state.pending || status === null) return null;
  return status === null ? null : { phase: status.phase, ...(status.activeModel === undefined ? {} : { activeModel: status.activeModel }) };
}

async function policyAtCommit(selection: ModelSelection, manager: GpuManagerController) {
  if (selection.provider !== LOCAL_PROVIDER_ID) {
    return modelPolicy({ providerId: selection.provider, id: selection.model }, null);
  }
  const status = await manager.refresh();
  // Use this guard's own response. A concurrent picker watcher may supersede
  // the shared UI snapshot; a superseded/failed refresh must remain fail-closed.
  return modelPolicy({ providerId: selection.provider, id: selection.model }, status);
}

function GpuModelSeat({ locked, available, directory, manager, load, select, openManager }: GpuModelSeatInjected & { readonly locked: boolean }) {
  const stopStatusWatch = useRef<(() => void) | null>(null);
  const directoryState = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
  const managerState = useSyncExternalStore(manager.store.subscribe, manager.store.getSnapshot, manager.store.getSnapshot);
  const managerAvailability = availabilityFromState(managerState);
  useEffect(() => {
    if (available) load();
  }, [available, load]);
  useEffect(() => () => { stopStatusWatch.current?.(); }, []);
  if (!available) return null;
  return <GpuModelSelect
    options={modelOptions(directoryState)}
    current={directoryState.current === null ? null : {
      providerId: directoryState.current.provider,
      id: directoryState.current.model,
      ...(directoryState.current.reasoningEffort === undefined ? {} : { reasoningEffort: directoryState.current.reasoningEffort }),
    }}
    manager={managerAvailability}
    locked={locked}
    directoryStatus={directoryState.status}
    directoryError={directoryState.error}
    failures={directoryState.failures}
    onOpenMenu={() => {
      load();
    }}
    onMenuOpenChange={(open) => {
      stopStatusWatch.current?.();
      stopStatusWatch.current = open ? manager.watchStatus() : null;
    }}
    onReload={load}
    onOpenManager={openManager}
    onSelect={async (option) => {
      const selection = selectionForOption(directory.getSnapshot(), rowId(option.providerId, option.id));
      if (selection === undefined) return { accepted: false, error: '此模型已经不在目录中' };
      const accepted = await select(selection);
      return accepted ? { accepted: true } : {
        accepted: false,
        error: directory.getSnapshot().error ?? '模型选择失败，请重试',
      };
    }}
    onSelectEffort={async (reasoningEffort) => {
      const current = directory.getSnapshot().current;
      if (current === null) return { accepted: false, error: '请先选择模型' };
      const accepted = await select({
        provider: current.provider,
        model: current.model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      });
      return accepted ? { accepted: true } : {
        accepted: false,
        error: directory.getSnapshot().error ?? '模型选择失败，请重试',
      };
    }}
  />;
}

function GpuManagerHost({ sessionId, manager }: PropsRuntime<'conversation.session.header.utilities'> & GpuManagerHostInjected) {
  const state = useSyncExternalStore(manager.store.subscribe, manager.store.getSnapshot, manager.store.getSnapshot);
  return <GpuManagerDialog
    open={state.openSession === String(sessionId)}
    status={state.status}
    models={state.models}
    busy={state.busy}
    pending={state.pending}
    error={state.error}
    onAction={(action) => { void manager.submit(action); }}
    onCancelOperation={(operationId) => { void manager.cancel(operationId); }}
    onQueue={() => { void manager.resolveBusy('queue'); }}
    onForce={() => { void manager.resolveBusy('force'); }}
    onClose={() => manager.close(String(sessionId))}
  />;
}

export const inject = ['commandUi', 'connection', 'locale', 'sessions', 'slots', 'remote'];

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(gpuRemote);
  const gpuFiber = ctx.inject(['remote.gpuWorkloads'], (scope: ClientContext) => {
    const manager = new GpuManagerController(scope.remote.gpuWorkloads, {
      selectResidentModel: async (sessionId, model) => {
        const resolver = scope.get('modelDirectories') as ModelDirectoryResolver | undefined;
        if (resolver === undefined) throw new Error('model directory is unavailable');
        const directory = resolver.directoryFor(sessionId as SessionId);
        const loaded = await directory.load();
        const selection = selectionForOption(loaded, rowId(LOCAL_PROVIDER_ID, model));
        if (selection === undefined) throw new Error('resident model is absent from the session directory');
        await directory.select(selection);
      },
    });
    scope.effect(() => scope.locale.register(NS, { zh, en }), 'gpu-model-selection: dictionaries');
    const t = scope.locale.bind(NS);
    scope.plugin(ModelDirectoryResolver, { blockReason: () => '当前模型不可用，请先选择模型' });

    scope.inject(['commandUi', 'modelDirectories'], (commandScope: ClientContext) => {
      const command = commandScope.get('commandUi') as CommandUiContract;
      const models = commandScope.modelDirectories;
      const sessions = commandScope.get('sessions') as ISessions;
      commandScope.effect(() => command.register({
        name: 'model',
        description: t('command.description'),
        available: (session) => sessions.subagentAddress(session.sessionId) === undefined,
        ui: {
          kind: 'popupSelect',
          options: async (session) => {
            if (sessions.subagentAddress(session.sessionId) !== undefined) throw new Error('model selection is unavailable for addressed subagent sessions');
            return popupOptions(await models.directoryFor(session.sessionId).load());
          },
          onSelect: async (option, session) => {
            if (sessions.subagentAddress(session.sessionId) !== undefined) throw new Error('model selection is unavailable for addressed subagent sessions');
            const directory = models.directoryFor(session.sessionId);
            const selection = selectionForOption(directory.store.getSnapshot(), option.id);
            if (selection === undefined) throw new Error('this provider catalog is unavailable');
            const policy = await policyAtCommit(selection, manager);
            if (policy.disabled) throw new Error(policy.reason);
            await directory.select(selection);
          },
        },
      }), 'gpu-model-selection: /model contribution');
    });

    scope.inject(['slots', 'modelDirectories'], (slotScope: ClientContext) => {
      const models = slotScope.modelDirectories;
      const sessions = slotScope.get('sessions') as ISessions;
      slotScope.slots.inject('conversation.input.model', () => slotScope.slots.register({
        name: 'conversation.input.model',
        inject: (sessionId): GpuModelSeatInjected => {
          const directory = models.directoryFor(sessionId);
          const available = sessions.subagentAddress(sessionId) === undefined;
          return {
            available,
            directory: directory.store,
            manager,
            load: () => {
              if (available) directory.load().catch(() => undefined);
            },
            select: async (selection) => {
              if (!available) return false;
              const policy = await policyAtCommit(selection, manager);
              if (policy.disabled) return false;
              return directory.select(selection).then(() => true, () => false);
            },
            openManager: () => {
              manager.open(String(sessionId));
              void manager.refresh();
            },
          };
        },
      }, GpuModelSeat));

      slotScope.slots.inject('conversation.session.header.utilities', () => slotScope.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'gpu-workload-manager-dialog',
        order: 1_000,
        inject: (): GpuManagerHostInjected => ({ manager }),
      }, GpuManagerHost));
    });

    scope.on('command/executed', (sessionId, name, result) => {
      if (name !== 'gpu' || result.kind !== 'success') return;
      manager.open(String(sessionId));
      void manager.refresh();
    });

    void manager.refresh();
    return () => manager.dispose();
  });
  try {
    await gpuFiber;
  } catch (error) {
    await unmountRemote();
    throw error;
  }
  return async () => {
    await gpuFiber.dispose();
    await unmountRemote();
  };
}

function rowId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}
