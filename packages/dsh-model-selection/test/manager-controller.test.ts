import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { GpuManagerController, type BrowserGpuRemote } from '../src/manager-controller.js';

const modelList = {
  object: 'list' as const,
  data: [
    { id: 'qwen3.8-27b' as const, object: 'model' as const, status: { value: 'unloaded' as const } },
    { id: 'qwen3.8-27b-uncensored' as const, object: 'model' as const, status: { value: 'unloaded' as const } },
    { id: 'qwen3.8-27b-q4' as const, object: 'model' as const, status: { value: 'unloaded' as const } },
    { id: 'qwen3.8-27b-uncensored-q4' as const, object: 'model' as const, status: { value: 'unloaded' as const } },
  ],
};

afterEach(() => vi.useRealTimers());

describe('GpuManagerController', () => {
  it('invalidates cached availability while a foreground refresh is in flight', async () => {
    const remote = fakeRemote();
    remote.status.mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote);
    await controller.refresh();
    const status = deferred<RemoteResult<{ phase: 'READY'; activeModel: 'qwen3.8-27b-q4'; activeRequestCount: number }>>();
    const models = deferred<RemoteResult<typeof modelList>>();
    remote.status.mockReturnValueOnce(status.promise);
    remote.models.mockReturnValueOnce(models.promise);

    const refreshing = controller.refresh();

    expect(controller.store.getSnapshot()).toMatchObject({
      phase: 'loading', status: { phase: 'READY', activeModel: 'qwen3.8-27b' },
    });
    status.resolve(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    models.resolve(ok(modelList));
    await refreshing;
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'ready', status: { activeModel: 'qwen3.8-27b-q4' } });
    controller.dispose();
  });

  it('follows a transition discovered by a foreground refresh to its terminal state', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    remote.status
      .mockResolvedValueOnce(ok({ phase: 'STARTING', activeRequestCount: 0 }))
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote, { pollIntervalMs: 1000, maxPolls: 4 });

    await controller.refresh();

    expect(controller.store.getSnapshot().status?.phase).toBe('STARTING');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.getSnapshot().status?.phase).toBe('READY');
    controller.dispose();
  });

  it('resumes accepted-operation polling when a foreground refresh fails transiently', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    const selectResidentModel = vi.fn(async () => undefined);
    remote.submit.mockResolvedValue(ok({ kind: 'accepted', operation: operation('RUNNING', '22222222-2222-4222-8222-222222222222') }));
    remote.status
      .mockResolvedValueOnce(ok({ phase: 'STARTING', activeRequestCount: 0 }))
      .mockResolvedValueOnce({ ok: false, error: { code: 'rpc', message: 'temporary', details: {} } })
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote, {
      uuid: sequenceUuid(), pollIntervalMs: 1000, maxPolls: 2, selectResidentModel,
    });
    controller.open('session-a');

    await controller.submit({ action: 'load', model: 'qwen3.8-27b-q4', onBusy: 'reject' });
    expect(vi.getTimerCount()).toBe(1);
    await controller.refresh();
    expect(controller.store.getSnapshot().phase).toBe('error');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'ready', status: { phase: 'READY', activeModel: 'qwen3.8-27b-q4' } });
    expect(selectResidentModel).toHaveBeenCalledWith('session-a', 'qwen3.8-27b-q4');
    controller.dispose();
  });

  it('serializes a picker watcher behind a foreground refresh without losing transition polling', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    const foregroundStatus = deferred<RemoteResult<{ phase: 'DRAINING'; activeRequestCount: number; target: 'qwen3.8-27b-q4' }>>();
    remote.submit.mockResolvedValue(ok({ kind: 'accepted', operation: operation('RUNNING', '22222222-2222-4222-8222-222222222222') }));
    remote.status
      .mockResolvedValueOnce(ok({ phase: 'STARTING', activeRequestCount: 0 }))
      .mockReturnValueOnce(foregroundStatus.promise)
      .mockResolvedValueOnce(ok({ phase: 'DRAINING', activeRequestCount: 1, target: 'qwen3.8-27b-q4' }))
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote, { uuid: sequenceUuid(), pollIntervalMs: 1000, maxPolls: 2 });

    await controller.submit({ action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'queue' });
    const foreground = controller.refresh();
    const stopWatcher = controller.watchStatus();
    await vi.advanceTimersByTimeAsync(0);
    expect(remote.status).toHaveBeenCalledTimes(2);
    foregroundStatus.resolve(ok({ phase: 'DRAINING', activeRequestCount: 1, target: 'qwen3.8-27b-q4' }));
    await foreground;
    await vi.advanceTimersByTimeAsync(0);
    expect(remote.status).toHaveBeenCalledTimes(3);
    expect(controller.store.getSnapshot().status?.phase).toBe('DRAINING');
    stopWatcher();

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.getSnapshot().status?.phase).toBe('READY');
    controller.dispose();
  });

  it('serializes a picker watcher behind the accepted-operation refresh and still reaches terminal state', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    const immediateStatus = deferred<RemoteResult<{ phase: 'DRAINING'; activeRequestCount: number; target: 'qwen3.8-27b-q4' }>>();
    remote.submit.mockResolvedValue(ok({ kind: 'accepted', operation: operation('RUNNING', '22222222-2222-4222-8222-222222222222') }));
    remote.status
      .mockReturnValueOnce(immediateStatus.promise)
      .mockResolvedValueOnce(ok({ phase: 'DRAINING', activeRequestCount: 1, target: 'qwen3.8-27b-q4' }))
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote, { uuid: sequenceUuid(), pollIntervalMs: 1000, maxPolls: 1 });

    const submitting = controller.submit({ action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'queue' });
    await Promise.resolve();
    const stopWatcher = controller.watchStatus();
    expect(remote.status).toHaveBeenCalledTimes(1);
    immediateStatus.resolve(ok({ phase: 'DRAINING', activeRequestCount: 1, target: 'qwen3.8-27b-q4' }));
    await submitting;
    await vi.advanceTimersByTimeAsync(0);
    stopWatcher();

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.getSnapshot().status?.phase).toBe('READY');
    controller.dispose();
  });

  it('does not charge a successful watcher queued behind a poll against the transport-error budget', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    const polledStatus = deferred<RemoteResult<{ phase: 'DRAINING'; activeRequestCount: number; target: 'qwen3.8-27b-q4' }>>();
    remote.submit.mockResolvedValue(ok({ kind: 'accepted', operation: operation('RUNNING', '22222222-2222-4222-8222-222222222222') }));
    remote.status
      .mockResolvedValueOnce(ok({ phase: 'STARTING', activeRequestCount: 0 }))
      .mockReturnValueOnce(polledStatus.promise)
      .mockResolvedValueOnce(ok({ phase: 'DRAINING', activeRequestCount: 1, target: 'qwen3.8-27b-q4' }))
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote, { uuid: sequenceUuid(), pollIntervalMs: 1000, maxPolls: 1 });

    await controller.submit({ action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'queue' });
    await vi.advanceTimersByTimeAsync(1000);
    const stopWatcher = controller.watchStatus();
    polledStatus.resolve(ok({ phase: 'DRAINING', activeRequestCount: 1, target: 'qwen3.8-27b-q4' }));
    await vi.advanceTimersByTimeAsync(0);
    stopWatcher();

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.getSnapshot().status?.phase).toBe('READY');
    controller.dispose();
  });

  it('does not exhaust the error retry budget while valid transition states keep advancing', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    remote.submit.mockResolvedValue(ok({ kind: 'accepted', operation: operation('RUNNING', '22222222-2222-4222-8222-222222222222') }));
    remote.status
      .mockResolvedValueOnce(ok({ phase: 'STARTING', activeRequestCount: 0 }))
      .mockResolvedValueOnce(ok({ phase: 'DRAINING', activeRequestCount: 1, target: 'qwen3.8-27b-q4' }))
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote, { uuid: sequenceUuid(), pollIntervalMs: 1000, maxPolls: 1 });

    await controller.submit({ action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'queue' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.getSnapshot().status?.phase).toBe('DRAINING');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.getSnapshot().status?.phase).toBe('READY');
    controller.dispose();
  });

  it('refreshes only while a model picker status watch is active', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    remote.status
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0 }))
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote, { pollIntervalMs: 1000 });

    const stop = controller.watchStatus();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.store.getSnapshot().status?.activeModel).toBe('qwen3.8-27b');
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.getSnapshot().status?.activeModel).toBe('qwen3.8-27b-q4');
    stop();
    const callsAfterClose = remote.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(remote.status).toHaveBeenCalledTimes(callsAfterClose);
    controller.dispose();
  });

  it('keeps a single watch loop when the picker closes and reopens during a deferred refresh', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    const first = deferred<RemoteResult<{ phase: 'READY'; activeModel: 'qwen3.8-27b'; activeRequestCount: number }>>();
    const second = deferred<RemoteResult<{ phase: 'READY'; activeModel: 'qwen3.8-27b-q4'; activeRequestCount: number }>>();
    remote.status.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const controller = new GpuManagerController(remote, { pollIntervalMs: 1000 });

    const stopFirst = controller.watchStatus();
    stopFirst();
    const stopSecond = controller.watchStatus();
    first.resolve(ok({ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0 }));
    second.resolve(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(1);
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });

  it('drops a queued picker refresh when the menu closes before the refresh lock is available', async () => {
    const remote = fakeRemote();
    const foregroundStatus = deferred<RemoteResult<{ phase: 'READY'; activeModel: 'qwen3.8-27b'; activeRequestCount: number }>>();
    remote.status.mockReturnValueOnce(foregroundStatus.promise);
    const controller = new GpuManagerController(remote);

    const foreground = controller.refresh();
    const stopWatcher = controller.watchStatus();
    stopWatcher();
    foregroundStatus.resolve(ok({ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0 }));
    await foreground;
    await Promise.resolve();

    expect(remote.status).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('unwraps RemoteResult, refreshes explicitly, and never starts an operation on open', async () => {
    const remote = fakeRemote();
    const controller = new GpuManagerController(remote, { uuid: sequenceUuid() });
    controller.open('session-a');
    await controller.refresh();
    expect(controller.store.getSnapshot()).toMatchObject({ openSession: 'session-a', phase: 'ready', status: { phase: 'UNLOADED' }, models: modelList.data, pending: false, busy: null });
    expect(remote.submit).not.toHaveBeenCalled();
    controller.close('session-b');
    expect(controller.store.getSnapshot().openSession).toBe('session-a');
    controller.close('session-a');
    expect(controller.store.getSnapshot().openSession).toBeNull();
  });

  it('keeps busy details, then queues with a new idempotency key', async () => {
    const remote = fakeRemote();
    remote.submit
      .mockResolvedValueOnce(ok({ kind: 'busy', code: 'local_model_busy', activeRequestCount: 2, activeModel: 'qwen3.8-27b', targetModel: 'qwen3.8-27b-q4' }))
      .mockResolvedValueOnce(ok({ kind: 'accepted', operation: operation('QUEUED', '22222222-2222-4222-8222-222222222222') }));
    const controller = new GpuManagerController(remote, { uuid: sequenceUuid(), pollIntervalMs: 10, maxPolls: 1 });
    await controller.submit({ action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'reject' });
    expect(controller.store.getSnapshot().busy).toMatchObject({ activeRequestCount: 2, activeModel: 'qwen3.8-27b', targetModel: 'qwen3.8-27b-q4' });
    await controller.resolveBusy('queue');
    const requests = remote.submit.mock.calls.map(([request]) => request);
    expect(requests[0]).toMatchObject({ onBusy: 'reject', idempotencyKey: '00000000-0000-4000-8000-000000000001' });
    expect(requests[1]).toMatchObject({ onBusy: 'queue', idempotencyKey: '00000000-0000-4000-8000-000000000002' });
    expect(controller.store.getSnapshot().busy).toBeNull();
    controller.dispose();
  });

  it('polls only during transitions, stops at terminal state, and cleans timers on dispose', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    remote.submit.mockResolvedValue(ok({ kind: 'accepted', operation: operation('RUNNING', '22222222-2222-4222-8222-222222222222') }));
    remote.status
      .mockResolvedValueOnce(ok({ phase: 'STARTING', activeRequestCount: 0 }))
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote, { uuid: sequenceUuid(), pollIntervalMs: 1000, maxPolls: 4 });
    await controller.submit({ action: 'load', model: 'qwen3.8-27b-q4', onBusy: 'reject' });
    expect(controller.store.getSnapshot().status?.phase).toBe('STARTING');
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.getSnapshot().status?.phase).toBe('READY');
    const callsAtTerminal = remote.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(remote.status).toHaveBeenCalledTimes(callsAtTerminal);
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('selects a newly resident model only in the session that initiated the manual operation', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    const selectResidentModel = vi.fn(async () => undefined);
    remote.submit.mockResolvedValue(ok({ kind: 'accepted', operation: operation('RUNNING', '22222222-2222-4222-8222-222222222222') }));
    remote.status
      .mockResolvedValueOnce(ok({ phase: 'STARTING', activeRequestCount: 0 }))
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote, {
      uuid: sequenceUuid(), pollIntervalMs: 1000, maxPolls: 4, selectResidentModel,
    });
    controller.open('session-a');

    await controller.submit({ action: 'load', model: 'qwen3.8-27b-q4', onBusy: 'reject' });
    expect(selectResidentModel).not.toHaveBeenCalled();
    controller.close('session-a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(selectResidentModel).toHaveBeenCalledTimes(1);
    expect(selectResidentModel).toHaveBeenCalledWith('session-a', 'qwen3.8-27b-q4');

    await controller.refresh();
    expect(selectResidentModel).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('does not let a pre-submit status response clear the accepted switch selection', async () => {
    const remote = fakeRemote();
    const staleStatus = deferred<RemoteResult<{ phase: 'READY'; activeModel: 'qwen3.8-27b'; activeRequestCount: number }>>();
    const selectResidentModel = vi.fn(async () => undefined);
    remote.status
      .mockReturnValueOnce(staleStatus.promise)
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    remote.submit.mockResolvedValue(ok({ kind: 'accepted', operation: operation('RUNNING', '22222222-2222-4222-8222-222222222222') }));
    const controller = new GpuManagerController(remote, {
      uuid: sequenceUuid(), pollIntervalMs: 1000, maxPolls: 2, selectResidentModel,
    });
    controller.open('session-a');

    const stopWatcher = controller.watchStatus();
    const submitting = controller.submit({ action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'reject' });
    await Promise.resolve();
    staleStatus.resolve(ok({ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0 }));
    await submitting;

    expect(selectResidentModel).toHaveBeenCalledTimes(1);
    expect(selectResidentModel).toHaveBeenCalledWith('session-a', 'qwen3.8-27b-q4');
    stopWatcher();
    controller.dispose();
  });

  it('keeps monitoring an existing transition when a second submission conflicts', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    remote.submit
      .mockResolvedValueOnce(ok({ kind: 'accepted', operation: operation('RUNNING', '22222222-2222-4222-8222-222222222222') }))
      .mockResolvedValueOnce(ok({ kind: 'conflict', code: 'operation_in_progress' }));
    remote.status
      .mockResolvedValueOnce(ok({ phase: 'STARTING', activeRequestCount: 0 }))
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote, { uuid: sequenceUuid(), pollIntervalMs: 1000, maxPolls: 4 });

    await controller.submit({ action: 'load', model: 'qwen3.8-27b', onBusy: 'reject' });
    expect(vi.getTimerCount()).toBe(1);
    await controller.submit({ action: 'unload', onBusy: 'reject' });
    expect(controller.store.getSnapshot().error).toBe('另一个 GPU 操作正在进行');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.getSnapshot().status?.phase).toBe('READY');
    controller.dispose();
  });

  it('polls an accepted operation even when its immediate refresh fails over a stale terminal snapshot', async () => {
    vi.useFakeTimers();
    const remote = fakeRemote();
    remote.submit.mockResolvedValue(ok({ kind: 'accepted', operation: operation('RUNNING', '22222222-2222-4222-8222-222222222222') }));
    remote.status
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0 }))
      .mockResolvedValueOnce({ ok: false, error: { code: 'rpc', message: 'temporary', details: {} } })
      .mockResolvedValueOnce(ok({ phase: 'READY', activeModel: 'qwen3.8-27b-q4', activeRequestCount: 0 }));
    const controller = new GpuManagerController(remote, { uuid: sequenceUuid(), pollIntervalMs: 1000, maxPolls: 4 });

    await controller.refresh();
    await controller.submit({ action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'reject' });
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'error', status: { phase: 'READY', activeModel: 'qwen3.8-27b' } });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'ready', status: { phase: 'READY', activeModel: 'qwen3.8-27b-q4' } });
    controller.dispose();
  });

  it('surfaces a stable error, supports operation cancellation, and aborts work on dispose', async () => {
    const remote = fakeRemote();
    remote.status.mockResolvedValue({ ok: false, error: { code: 'rpc', message: 'secret upstream detail', details: {} } });
    const controller = new GpuManagerController(remote, { uuid: sequenceUuid() });
    await controller.refresh();
    expect(controller.store.getSnapshot().error).toBe('GPU Workload Manager 暂不可用');
    expect(controller.store.getSnapshot().error).not.toContain('secret');

    remote.cancel.mockResolvedValue(ok({ kind: 'conflict', code: 'operation_not_cancellable' }));
    await controller.cancel('22222222-2222-4222-8222-222222222222');
    expect(remote.cancel).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', expect.any(AbortSignal));
    controller.dispose();
    const signal = remote.cancel.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(true);
  });
});

function fakeRemote(): BrowserGpuRemote & { [K in keyof BrowserGpuRemote]: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn(async () => ok({ phase: 'UNLOADED', activeRequestCount: 0 })),
    models: vi.fn(async () => ok(modelList)),
    submit: vi.fn(async () => ok({ kind: 'conflict', code: 'operation_in_progress' })),
    cancel: vi.fn(async () => ok({ kind: 'conflict', code: 'operation_not_found' })),
  } as never;
}

function ok<T>(value: T): RemoteResult<T> { return { ok: true, value }; }
function operation(status: 'QUEUED' | 'RUNNING', id: string) {
  return { id, request: { idempotencyKey: '11111111-1111-4111-8111-111111111111', action: 'unload' as const, onBusy: 'queue' as const }, status };
}
function sequenceUuid() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
