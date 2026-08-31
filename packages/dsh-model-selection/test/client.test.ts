// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSelection, SessionId, SessionModels } from '@deepseek-ai/dsh-api-remotes/client';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { GpuManagerStatus, GpuModelList } from '@local/dsh-gpu-workload-manager/types';

import { DISABLED_LOCAL_REASON } from '../src/policy.js';
import {
  apply,
  inject,
  modelOptions,
  selectionForOption,
  type GpuManagerHostInjected,
  type GpuModelSeatInjected,
} from '../src/client.js';

const sid = (value: string) => value as SessionId;

const catalog: SessionModels = {
  current: { provider: 'deepseek', model: 'deepseek-chat' },
  routable: true,
  groups: [
    { id: 'llama-local', name: 'Ubuntu Local', models: [
      { id: 'qwen3.8-27b', name: 'Qwen3.8 27B Q5', reasoning: { efforts: [], defaultEffort: 'high' } },
      { id: 'qwen3.8-27b-q4', name: 'Qwen3.8 27B Q4' },
    ] },
    { id: 'deepseek', name: 'Online', models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    ] },
  ],
  failures: [{ id: 'broken-online', name: 'Broken Online', message: 'timeout' }],
};

afterEach(() => vi.restoreAllMocks());

describe('directory adapters', () => {
  it('preserves opaque model identities and provider defaults', () => {
    expect(modelOptions(catalog)).toEqual([
      {
        providerId: 'llama-local',
        id: 'qwen3.8-27b',
        label: 'Qwen3.8 27B Q5',
        detail: 'Ubuntu Local',
        reasoning: { efforts: [], defaultEffort: 'high' },
      },
      { providerId: 'llama-local', id: 'qwen3.8-27b-q4', label: 'Qwen3.8 27B Q4', detail: 'Ubuntu Local' },
      { providerId: 'deepseek', id: 'deepseek-chat', label: 'DeepSeek Chat', detail: 'Online' },
    ]);
    expect(selectionForOption(directoryState(catalog), 'llama-local/qwen3.8-27b')).toEqual({
      provider: 'llama-local', model: 'qwen3.8-27b', reasoningEffort: 'high',
    });
    expect(selectionForOption(directoryState(catalog), 'missing/model')).toBeUndefined();
  });
});

describe('DSH client integration', () => {
  it('keeps the mounted namespace out of the parent dependency list so apply can mount it', () => {
    expect(inject).toContain('remote');
    expect(inject).not.toContain('remote.gpuWorkloads');
  });

  it('mounts the generated Remote once, registers both selection entries, and guards local selection at commit time', async () => {
    const bench = await createBench();
    expect(bench.remote.mount).toHaveBeenCalledTimes(1);
    expect(bench.remote.mount.mock.calls[0]?.[0]).toMatchObject({ package: '@local/dsh-gpu-workload-manager' });
    expect(bench.command()?.name).toBe('model');
    expect(bench.seat('conversation.input.model')).toBeDefined();
    expect(bench.seat('conversation.session.header.utilities')).toBeDefined();

    const options = await bench.command()!.ui.options({ sessionId: sid('a') }, new AbortController().signal);
    const local = options.find((option: { id: string }) => option.id === 'llama-local/qwen3.8-27b')!;
    const cloud = options.find((option: { id: string }) => option.id === 'deepseek/deepseek-chat')!;
    const providerFailure = options.find((option: { id: string }) => option.id === 'failure/broken-online')!;
    expect(providerFailure).toMatchObject({ label: 'Broken Online', detail: '目录加载失败：timeout' });
    await expect(bench.command()!.ui.onSelect(local, { sessionId: sid('a') })).rejects.toThrow(DISABLED_LOCAL_REASON);
    await expect(bench.command()!.ui.onSelect(providerFailure, { sessionId: sid('a') })).rejects.toThrow('provider catalog is unavailable');
    expect(bench.selectModel).not.toHaveBeenCalled();
    const statusCallsBeforeCloud = bench.remote.status.mock.calls.length;
    await bench.command()!.ui.onSelect(cloud, { sessionId: sid('a') });
    expect(bench.selectModel).toHaveBeenLastCalledWith({ sessionId: sid('a'), provider: 'deepseek', model: 'deepseek-chat' });
    expect(bench.remote.status).toHaveBeenCalledTimes(statusCallsBeforeCloud);

    const seat = bench.seat('conversation.input.model')!.inject!(sid('a')) as GpuModelSeatInjected;
    await expect(seat.select({ provider: 'llama-local', model: 'qwen3.8-27b' })).resolves.toBe(false);
    expect(bench.selectModel).toHaveBeenCalledTimes(1);

    bench.setGpuStatus({ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0 });
    const host = bench.seat('conversation.session.header.utilities')!.inject!(sid('a')) as GpuManagerHostInjected;
    await host.manager.refresh();
    await bench.command()!.ui.onSelect(local, { sessionId: sid('a') });
    expect(bench.selectModel).toHaveBeenLastCalledWith({ sessionId: sid('a'), provider: 'llama-local', model: 'qwen3.8-27b', reasoningEffort: 'high' });
    expect(bench.remote.submit).not.toHaveBeenCalled();

    const callsBeforeRemoteSwitch = bench.selectModel.mock.calls.length;
    bench.setGpuStatus({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 });
    await expect(seat.select({ provider: 'llama-local', model: 'qwen3.8-27b' })).resolves.toBe(false);
    await expect(bench.command()!.ui.onSelect(local, { sessionId: sid('a') })).rejects.toThrow(DISABLED_LOCAL_REASON);
    expect(bench.selectModel).toHaveBeenCalledTimes(callsBeforeRemoteSwitch);

    const callsBeforeFailure = bench.selectModel.mock.calls.length;
    bench.remote.status.mockResolvedValueOnce({ ok: false, error: { code: 'rpc', message: 'offline', details: {} } });
    await host.manager.refresh();
    await expect(seat.select({ provider: 'llama-local', model: 'qwen3.8-27b' })).resolves.toBe(false);
    expect(bench.selectModel).toHaveBeenCalledTimes(callsBeforeFailure);

    await bench.dispose();
    expect(bench.remote.unmount).toHaveBeenCalledTimes(1);
  });

  it('opens only the addressed session after a successful local /gpu command and refreshes without auto-loading', async () => {
    const bench = await createBench();
    const hostA = bench.seat('conversation.session.header.utilities')!.inject!(sid('a')) as GpuManagerHostInjected;
    bench.ctx.emit('command/executed', sid('b'), 'gpu', { kind: 'error', text: 'no' });
    expect(hostA.manager.store.getSnapshot().openSession).toBeNull();
    bench.ctx.emit('command/executed', sid('b'), 'other', { kind: 'success' });
    expect(hostA.manager.store.getSnapshot().openSession).toBeNull();
    bench.ctx.emit('command/executed', sid('b'), 'gpu', { kind: 'success' });
    await Promise.resolve();
    expect(hostA.manager.store.getSnapshot().openSession).toBe('b');
    expect(bench.remote.status).toHaveBeenCalled();
    expect(bench.remote.submit).not.toHaveBeenCalled();
    expect(bench.selectModel).not.toHaveBeenCalled();
    await bench.dispose();
  });

  it('selects a manually loaded model only for the dialog session that initiated it', async () => {
    const bench = await createBench();
    const host = bench.seat('conversation.session.header.utilities')!.inject!(sid('a')) as GpuManagerHostInjected;
    host.manager.open('a');
    bench.setGpuStatus({ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0 });
    bench.remote.submit.mockResolvedValueOnce(ok({
      kind: 'accepted',
      operation: {
        id: '22222222-2222-4222-8222-222222222222',
        request: { idempotencyKey: '00000000-0000-4000-8000-000000000001', action: 'load', model: 'qwen3.8-27b', onBusy: 'reject' },
        status: 'RUNNING',
      },
    }));

    await host.manager.submit({ action: 'load', model: 'qwen3.8-27b', onBusy: 'reject' });
    expect(bench.selectModel).toHaveBeenCalledTimes(1);
    expect(bench.selectModel).toHaveBeenCalledWith({
      sessionId: sid('a'), provider: 'llama-local', model: 'qwen3.8-27b', reasoningEffort: 'high',
    });
    await bench.dispose();
  });

  it('fails a local commit closed when a concurrent watcher supersedes its own fresh status response', async () => {
    const bench = await createBench();
    const host = bench.seat('conversation.session.header.utilities')!.inject!(sid('a')) as GpuManagerHostInjected;
    const seat = bench.seat('conversation.input.model')!.inject!(sid('a')) as GpuModelSeatInjected;
    bench.setGpuStatus({ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0 });
    await host.manager.refresh();
    const commitStatus = deferred<RemoteResult<GpuManagerStatus>>();
    const watcherStatus = deferred<RemoteResult<GpuManagerStatus>>();
    bench.remote.status.mockReturnValueOnce(commitStatus.promise).mockReturnValueOnce(watcherStatus.promise);

    const committing = seat.select({ provider: 'llama-local', model: 'qwen3.8-27b' });
    await Promise.resolve();
    const stopWatcher = host.manager.watchStatus();
    watcherStatus.resolve(ok({ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0 }));
    await Promise.resolve();
    commitStatus.resolve(ok({ phase: 'DRAINING', activeRequestCount: 1, target: 'qwen3.8-27b-q4' }));

    await expect(committing).resolves.toBe(false);
    expect(bench.selectModel).not.toHaveBeenCalled();
    stopWatcher();
    await bench.dispose();
  });
});

async function createBench() {
  const ctx = new Context();
  const seats = new Map<string, { inject?: (sessionId: SessionId) => unknown }>();
  let command: any;
  const modelsForSession = vi.fn(async () => ({ result: ok(catalog) }));
  const selectModel = vi.fn(async (request: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string }) => ({
    result: ok({ selected: {
      provider: request.provider,
      model: request.model,
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    } }),
  }));
  let gpuStatus: GpuManagerStatus = { phase: 'UNLOADED', activeRequestCount: 0 };
  let remoteNamespaceDispose: (() => Promise<void>) | undefined;
  const models: GpuModelList = { object: 'list', data: [
    { id: 'qwen3.8-27b', object: 'model', status: { value: 'unloaded' } },
    { id: 'qwen3.8-27b-uncensored', object: 'model', status: { value: 'unloaded' } },
    { id: 'qwen3.8-27b-q4', object: 'model', status: { value: 'unloaded' } },
    { id: 'qwen3.8-27b-uncensored-q4', object: 'model', status: { value: 'unloaded' } },
  ] };
  const remote = {
    status: vi.fn(async () => ok(gpuStatus)),
    models: vi.fn(async () => ok(models)),
    submit: vi.fn(),
    cancel: vi.fn(),
    unmount: vi.fn(async () => undefined),
    mount: vi.fn(async function (this: any) {
      this.gpuWorkloads = this;
      remoteNamespaceDispose = ctx.provide('remote.gpuWorkloads', remote as never);
      return remote.unmount;
    }),
    async $mount(contribution: unknown) { return remote.mount.call(this, contribution); },
    $on: vi.fn(() => undefined),
  };
  remote.unmount.mockImplementation(async () => {
    await remoteNamespaceDispose?.();
    remoteNamespaceDispose = undefined;
  });
  ctx.provide('remote', remote as never);
  ctx.provide('connection', { api: { sessions: { models: modelsForSession, selectModel } } } as never);
  ctx.provide('sessions', {
    subagentAddress: () => undefined,
    scope: () => ctx,
  } as never);
  ctx.provide('locale', {
    register: () => () => undefined,
    bind: () => (key: string) => key === 'command.description' ? '选择模型' : key,
  } as never);
  ctx.provide('commandUi', {
    register(value: unknown) { command = value; return () => { command = undefined; }; },
  } as never);
  ctx.provide('slots', {
    inject(_name: string, callback: () => () => void) { return callback(); },
    register(options: { name: string; inject?: (sessionId: SessionId) => unknown }) {
      seats.set(options.name, options);
      return () => seats.delete(options.name);
    },
  } as never);

  const fiber = ctx.plugin({ inject: [...inject], apply });
  await fiber.await();
  await Promise.resolve();
  return {
    ctx,
    modelsForSession,
    selectModel,
    remote,
    command: () => command,
    seat: (name: string) => seats.get(name),
    setGpuStatus(value: GpuManagerStatus) { gpuStatus = value; },
    async dispose() { await fiber.dispose(); },
  };
}

function directoryState(value: SessionModels) {
  return { current: value.current, routable: value.routable, groups: value.groups, failures: value.failures, status: 'ready' as const, error: null };
}


function ok<T>(value: T): RemoteResult<T> { return { ok: true, value }; }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
