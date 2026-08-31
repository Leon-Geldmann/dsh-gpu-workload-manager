import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { ModelSpec, OperationRequest } from '@local/gpu-workload-core';
import { ManagerEngine, type ChildExitEvent } from '../src/manager-engine.js';
import { Metrics } from '../src/metrics.js';

const base: ModelSpec = { id: 'qwen3.8-27b', path: '/catalog/base.gguf', contextSize: 8192, mtp: 0 };
const q4: ModelSpec = { id: 'qwen3.8-27b-q4', path: '/catalog/q4.gguf', contextSize: 16384, mtp: 0 };

it('starts unloaded even if a persisted model is supplied', () => {
  const engine = new ManagerEngine({ catalog: [base, q4], supervisor: new FakeSupervisor(), persistedActiveModel: base.id });
  expect(engine.snapshot()).toMatchObject({ phase: 'UNLOADED', activeRequestCount: 0 });
  expect(engine.snapshot()).not.toHaveProperty('activeModel');
});

it('linearizes identical concurrent submissions and rejects a different intent', async () => {
  const supervisor = new FakeSupervisor();
  const engine = await readyEngine(supervisor);
  const request = operation('switch', q4.id, 'reject', '4dc7c4c0-d0d4-437f-89d8-dbc0f39ac967');
  const [first, same, different] = await Promise.all([
    engine.submit(request, 'mac'),
    engine.submit({ ...request }, 'ubuntu'),
    engine.submit(operation('unload'), 'ubuntu'),
  ]);

  expect(first.kind).toBe('accepted');
  expect(same).toMatchObject({ kind: 'accepted', operation: { id: (first as { operation: { id: string } }).operation.id } });
  expect(different).toMatchObject({ kind: 'conflict', code: 'operation_in_progress' });
  expect(supervisor.stops).toHaveLength(1);
  supervisor.releaseStart();
  await engine.whenSettled();
  expect(supervisor.starts.map((model) => model.id)).toEqual([q4.id]);
});

it('reports an idempotency conflict without changing an active operation', async () => {
  const supervisor = new FakeSupervisor();
  const engine = await readyEngine(supervisor);
  const key = randomUUID();
  const accepted = await engine.submit(operation('switch', q4.id, 'reject', key), 'mac');
  const conflict = await engine.submit(operation('switch', q4.id, 'queue', key), 'mac');
  expect(accepted.kind).toBe('accepted');
  expect(conflict).toMatchObject({ kind: 'conflict', code: 'idempotency_conflict' });
  supervisor.releaseStart();
  await engine.whenSettled();
});

it('rejects busy without mutating readiness, admission, or the child', async () => {
  const supervisor = new FakeSupervisor();
  const engine = await readyEngine(supervisor);
  const lease = engine.admitInference(base.id);
  expect(lease.kind).toBe('admitted');
  const result = await engine.submit(operation('switch', q4.id, 'reject'), 'mac');
  expect(result).toMatchObject({ kind: 'busy', code: 'local_model_busy', activeRequestCount: 1 });
  expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: base.id, activeRequestCount: 1 });
  expect(supervisor.stops).toHaveLength(0);
});

it('replays the original busy payload after request count changes', async () => {
  const supervisor = new FakeSupervisor(); const engine = await readyEngine(supervisor);
  const local = engine.admitInference(base.id); if (local.kind !== 'admitted') throw new Error('expected');
  const request = operation('switch', q4.id, 'reject');
  const first = await engine.submit(request, 'mac');
  local.lease.complete();
  await expect(engine.submit(request, 'mac')).resolves.toEqual(first);
});

it('replays the initial accepted operation snapshot after it settles', async () => {
  const supervisor = new FakeSupervisor(); const engine = await readyEngine(supervisor);
  const request = operation('switch', q4.id);
  const first = await engine.submit(request, 'mac');
  supervisor.releaseStart(); await engine.whenSettled();
  await expect(engine.submit(request, 'mac')).resolves.toEqual(first);
});

it('fails current READY child crashes but ignores stale child exits', async () => {
  const supervisor = new FakeSupervisor(); const engine = await readyEngine(supervisor);
  const old = supervisor.current!;
  await engine.submit(operation('switch', q4.id), 'mac'); supervisor.releaseStart(); await engine.whenSettled();
  supervisor.emitExit(old);
  expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: q4.id });
  supervisor.emitExit(supervisor.current!);
  expect(engine.snapshot()).toMatchObject({ phase: 'FAILED', activeRequestCount: 0 });
  expect(engine.admitInference(q4.id)).toMatchObject({ kind: 'rejected', code: 'model_transition' });
});

it('fails and clears a queued drain when its resident child exits, then permits manual recovery', async () => {
  vi.useFakeTimers();
  try {
    let now = 0;
    const observeQueueWait = vi.fn();
    const supervisor = new FakeSupervisor();
    const engine = new ManagerEngine({
      catalog: [base, q4],
      supervisor,
      drainTimeoutMs: 10_000,
      now: () => now,
      telemetry: { observeQueueWait, addForceCancellations: vi.fn() },
    });
    await engine.submit(operation('load', base.id), 'test'); supervisor.releaseStart(); await engine.whenSettled(); supervisor.clearHistory();
    const child = supervisor.current!;
    const local = engine.admitInference(base.id); if (local.kind !== 'admitted') throw new Error('expected');
    let aborts = 0; local.lease.bindAbort(() => { aborts += 1; });
    now = 1_000;
    const queued = await engine.submit(operation('switch', q4.id, 'queue'), 'mac');
    const operationId = (queued as { operation: { id: string } }).operation.id;
    expect(vi.getTimerCount()).toBe(1);

    now = 2_500;
    supervisor.emitExit(child);

    expect(aborts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(observeQueueWait).toHaveBeenCalledWith(q4.id, 1.5);
    expect(engine.snapshot()).toEqual({ phase: 'FAILED', activeRequestCount: 0 });
    expect(engine.operations().find((entry) => entry.id === operationId)).toMatchObject({ status: 'FAILED', error: { code: 'child_exited' } });

    await expect(engine.submit(operation('load', base.id), 'ubuntu')).resolves.toMatchObject({ kind: 'accepted' });
    await engine.whenSettled();
    expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: base.id, activeRequestCount: 0 });
    await engine.shutdown();
  } finally { vi.useRealTimers(); }
});

it('shuts down once, aborts local work, and stops a READY child gracefully', async () => {
  const supervisor = new FakeSupervisor(); const engine = await readyEngine(supervisor);
  const local = engine.admitInference(base.id); if (local.kind !== 'admitted') throw new Error('expected');
  const [one, two] = [engine.shutdown(), engine.shutdown()];
  expect(one).toBe(two);
  await one;
  expect(local.lease.aborted).toBe(true);
  expect(supervisor.stops).toEqual(['manager_shutdown']);
  expect(engine.snapshot()).toMatchObject({ phase: 'UNLOADED', activeRequestCount: 0 });
});

it('rejects re-entrant and late submissions after shutdown linearizes', async () => {
  const supervisor = new FakeSupervisor(); const engine = await readyEngine(supervisor);
  supervisor.deferNextStop();
  const local = engine.admitInference(base.id); if (local.kind !== 'admitted') throw new Error('expected');
  let reentrant: Promise<unknown> | undefined;
  local.lease.bindAbort(() => { reentrant = engine.submit(operation('switch', q4.id), 'reentrant-abort'); });

  const shutdown = engine.shutdown();
  await supervisor.stopEntered.promise;

  await expect(reentrant).resolves.toEqual({ kind: 'unavailable', code: 'manager_shutting_down' });
  await expect(engine.submit(operation('switch', q4.id), 'slow-control-body')).resolves.toEqual({ kind: 'unavailable', code: 'manager_shutting_down' });
  expect(supervisor.stops).toEqual(['manager_shutdown']);
  expect(supervisor.starts).toEqual([]);

  supervisor.releaseDeferredStop();
  await shutdown;
  await Promise.resolve(); await Promise.resolve();
  expect(supervisor.starts).toEqual([]);
  expect(engine.snapshot()).toEqual({ phase: 'UNLOADED', activeRequestCount: 0 });
});

it('waits for a deferred start to settle before its final shutdown stop', async () => {
  const supervisor = new FakeSupervisor(); const engine = await readyEngine(supervisor);
  supervisor.deferNextStart();
  await engine.submit(operation('switch', q4.id), 'mac');
  const shutdown = engine.shutdown();
  expect(supervisor.stops).toEqual(['model_transition']);
  supervisor.releaseDeferredStart();
  await shutdown;
  expect(supervisor.stops).toEqual(['model_transition', 'manager_shutdown']);
  expect(supervisor.activeChild).toBe(false);
  expect(engine.snapshot()).toMatchObject({ phase: 'UNLOADED', activeRequestCount: 0 });
});

it('completes an already-resident target as a no-op even while its one local slot is busy', async () => {
  const supervisor = new FakeSupervisor();
  const engine = await readyEngine(supervisor);
  const local = engine.admitInference(base.id);
  if (local.kind !== 'admitted') throw new Error('expected_lease');
  const result = await engine.submit(operation('switch', base.id, 'reject'), 'mac');
  expect(result).toMatchObject({ kind: 'noop', operation: { status: 'COMPLETED' } });
  expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: base.id, activeRequestCount: 1 });
  expect(supervisor.stops).toHaveLength(0);
});

it('drains admitted local work, closes admission atomically, and lets cancellation reopen READY', async () => {
  const supervisor = new FakeSupervisor();
  const engine = await readyEngine(supervisor);
  const local = engine.admitInference(base.id);
  if (local.kind !== 'admitted') throw new Error('expected_lease');
  const queued = await engine.submit(operation('switch', q4.id, 'queue'), 'mac');
  expect(queued).toMatchObject({ kind: 'accepted', operation: { status: 'QUEUED' } });
  expect(engine.snapshot()).toMatchObject({ phase: 'DRAINING', activeRequestCount: 1 });
  expect(engine.admitInference(base.id)).toMatchObject({ kind: 'rejected', code: 'model_transition' });
  expect(local.lease.aborted).toBe(false);

  const cancelled = engine.cancel((queued as { operation: { id: string } }).operation.id);
  expect(cancelled).toMatchObject({ kind: 'cancelled' });
  expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: base.id });
  expect(engine.admitInference(base.id).kind).toBe('rejected'); // local concurrency limit remains one.
  local.lease.complete();
  await engine.whenSettled();
  expect(supervisor.stops).toHaveLength(0);
});

it('lets cancellation win while drain-zero is paused before lifecycle commit', async () => {
  const supervisor = new FakeSupervisor(); const gate = new DrainGate(); const engine = await readyEngine(supervisor, gate);
  const local = engine.admitInference(base.id); if (local.kind !== 'admitted') throw new Error('expected');
  const queued = await engine.submit(operation('switch', q4.id, 'queue'), 'mac');
  local.lease.complete(); await gate.entered.promise;
  expect(engine.cancel((queued as { operation: { id: string } }).operation.id)).toMatchObject({ kind: 'cancelled' });
  gate.release(); await engine.whenSettled();
  expect(supervisor.stops).toEqual([]);
  expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: base.id });
});

it('makes cancellation conflict after drain lifecycle commits STOPPING', async () => {
  const supervisor = new FakeSupervisor(); const gate = new DrainGate(); const engine = await readyEngine(supervisor, gate);
  supervisor.deferNextStop();
  const local = engine.admitInference(base.id); if (local.kind !== 'admitted') throw new Error('expected');
  const queued = await engine.submit(operation('switch', q4.id, 'queue'), 'mac');
  local.lease.complete(); await gate.entered.promise; gate.release(); await supervisor.stopEntered.promise;
  expect(supervisor.stops).toEqual(['model_transition']);
  expect(engine.cancel((queued as { operation: { id: string } }).operation.id)).toMatchObject({ kind: 'conflict', code: 'operation_not_cancellable' });
  supervisor.releaseDeferredStop(); supervisor.releaseStart(); await engine.whenSettled();
  expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: q4.id });
});

it('queues then switches only after the current local lease completes', async () => {
  const supervisor = new FakeSupervisor();
  const engine = await readyEngine(supervisor);
  const local = engine.admitInference(base.id);
  if (local.kind !== 'admitted') throw new Error('expected_lease');
  await engine.submit(operation('switch', q4.id, 'queue'), 'mac');
  local.lease.complete();
  await Promise.resolve(); await Promise.resolve();
  expect(supervisor.stops).toHaveLength(1);
  supervisor.releaseStart();
  await engine.whenSettled();
  expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: q4.id, activeRequestCount: 0 });
});

it('forces only registered local leases and uses graceful supervisor stop', async () => {
  const supervisor = new FakeSupervisor();
  const engine = await readyEngine(supervisor);
  const local = engine.admitInference(base.id);
  if (local.kind !== 'admitted') throw new Error('expected_lease');
  let aborts = 0;
  local.lease.bindAbort(() => { aborts += 1; });
  const result = await engine.submit(operation('switch', q4.id, 'force'), 'ubuntu');
  expect(result.kind).toBe('accepted');
  expect(aborts).toBe(1);
  expect(local.lease.aborted).toBe(true);
  expect(supervisor.stops).toHaveLength(1);
  expect(supervisor.forceStops).toHaveLength(0);
  supervisor.releaseStart();
  await engine.whenSettled();
});

it('records queue wait and force cancellation against fixed resident catalog models', async () => {
  let now = 0;
  const metrics = new Metrics([base.id, q4.id]);
  const supervisor = new FakeSupervisor();
  const engine = new ManagerEngine({ catalog: [base, q4], supervisor, telemetry: metrics, now: () => now });
  await engine.submit(operation('load', base.id), 'test'); supervisor.releaseStart(); await engine.whenSettled(); supervisor.clearHistory();

  const first = engine.admitInference(base.id); if (first.kind !== 'admitted') throw new Error('expected');
  now = 1_000;
  await engine.submit(operation('switch', q4.id, 'queue'), 'mac');
  now = 3_500;
  first.lease.complete();
  await Promise.resolve(); await Promise.resolve();
  supervisor.releaseStart(); await engine.whenSettled();

  const second = engine.admitInference(q4.id); if (second.kind !== 'admitted') throw new Error('expected');
  await engine.submit(operation('switch', base.id, 'force'), 'ubuntu');
  supervisor.releaseStart(); await engine.whenSettled();

  const rendered = metrics.render(engine.snapshot());
  expect(rendered).toContain(`manager_queue_wait_seconds_sum{model="${q4.id}"} 2.5\n`);
  expect(rendered).toContain(`manager_force_cancellations_total{model="${q4.id}"} 1\n`);
  expect(rendered).toContain(`manager_force_cancellations_total{model="${base.id}"} 0\n`);
});

it('forces a live lease once despite re-entrant completion and an upstream abort error', async () => {
  const supervisor = new FakeSupervisor(); const engine = await readyEngine(supervisor);
  supervisor.deferNextStop();
  const local = engine.admitInference(base.id); if (local.kind !== 'admitted') throw new Error('expected');
  let aborts = 0;
  local.lease.bindAbort(() => { aborts += 1; local.lease.complete(); engine.completeInference(local.lease.id); throw new Error('simulated_upstream_abort'); });
  await expect(engine.submit(operation('switch', q4.id, 'force'), 'ubuntu')).resolves.toMatchObject({ kind: 'accepted' });
  await supervisor.stopEntered.promise;
  expect(aborts).toBe(1); expect(supervisor.stops).toEqual(['model_transition']);
  supervisor.releaseDeferredStop(); supervisor.releaseStart(); await engine.whenSettled();
  local.lease.complete(); engine.completeInference(local.lease.id);
  expect(aborts).toBe(1);
  expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: q4.id, activeRequestCount: 0 });
});

it('does not abort a lease that completed before force and still switches once', async () => {
  const supervisor = new FakeSupervisor(); const engine = await readyEngine(supervisor);
  const local = engine.admitInference(base.id); if (local.kind !== 'admitted') throw new Error('expected');
  let aborts = 0; local.lease.bindAbort(() => { aborts += 1; }); local.lease.complete();
  await engine.submit(operation('switch', q4.id, 'force'), 'ubuntu'); supervisor.releaseStart(); await engine.whenSettled();
  expect(aborts).toBe(0); expect(supervisor.stops).toEqual(['model_transition']);
});

it('fails a queued drain at its deadline and reopens admission without stopping the child', async () => {
  vi.useFakeTimers();
  try {
    const supervisor = new FakeSupervisor(); const engine = await readyEngine(supervisor, undefined, 50);
    const local = engine.admitInference(base.id); if (local.kind !== 'admitted') throw new Error('expected');
    const queued = await engine.submit(operation('switch', q4.id, 'queue'), 'mac');
    await vi.advanceTimersByTimeAsync(50);

    expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: base.id, activeRequestCount: 1 });
    expect(engine.operations().find((entry) => entry.id === (queued as { operation: { id: string } }).operation.id)).toMatchObject({ status: 'FAILED', error: { code: 'drain_timeout' } });
    expect(supervisor.stops).toEqual([]);
    local.lease.complete();
    const replacement = engine.admitInference(base.id); expect(replacement.kind).toBe('admitted');
    if (replacement.kind === 'admitted') replacement.lease.complete();
    await engine.shutdown();
  } finally { vi.useRealTimers(); }
});

it('keeps cancellation terminal when it wins the exact drain-deadline race', async () => {
  vi.useFakeTimers();
  try {
    const supervisor = new FakeSupervisor(); const engine = await readyEngine(supervisor, undefined, 50);
    const local = engine.admitInference(base.id); if (local.kind !== 'admitted') throw new Error('expected');
    const queued = await engine.submit(operation('switch', q4.id, 'queue'), 'mac');
    const operationId = (queued as { operation: { id: string } }).operation.id;
    expect(engine.cancel(operationId)).toMatchObject({ kind: 'cancelled', operation: { status: 'CANCELLED' } });
    await vi.advanceTimersByTimeAsync(50);
    expect(engine.operations().find((entry) => entry.id === operationId)).toMatchObject({ status: 'CANCELLED' });
    expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: base.id });
    expect(supervisor.stops).toEqual([]);
    local.lease.complete(); await engine.shutdown();
  } finally { vi.useRealTimers(); }
});

it('keeps timeout terminal when it wins the exact drain-deadline race', async () => {
  vi.useFakeTimers();
  try {
    const supervisor = new FakeSupervisor(); const engine = await readyEngine(supervisor, undefined, 50);
    const local = engine.admitInference(base.id); if (local.kind !== 'admitted') throw new Error('expected');
    const queued = await engine.submit(operation('switch', q4.id, 'queue'), 'mac');
    const operationId = (queued as { operation: { id: string } }).operation.id;
    await vi.advanceTimersByTimeAsync(50);
    expect(engine.cancel(operationId)).toMatchObject({ kind: 'conflict', code: 'operation_not_cancellable' });
    expect(engine.operations().find((entry) => entry.id === operationId)).toMatchObject({ status: 'FAILED', error: { code: 'drain_timeout' } });
    expect(supervisor.stops).toEqual([]);
    local.lease.complete(); await engine.shutdown();
  } finally { vi.useRealTimers(); }
});

it('rolls back exactly once when target start fails, then retains a failed operation', async () => {
  const supervisor = new FakeSupervisor([undefined, new Error('target_failed'), undefined]);
  const engine = await readyEngine(supervisor);
  await engine.submit(operation('switch', q4.id), 'mac');
  await engine.whenSettled();
  expect(supervisor.starts.map((model) => model.id)).toEqual([q4.id, base.id]);
  expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: base.id });
  expect(engine.operations().find((entry) => entry.request.model === q4.id)).toMatchObject({ status: 'FAILED', error: { code: 'target_start_failed' } });
});

it('publishes DEGRADED_UNLOADED when the single rollback start also fails', async () => {
  const supervisor = new FakeSupervisor([undefined, new Error('target'), new Error('rollback')]);
  const engine = await readyEngine(supervisor);
  await engine.submit(operation('switch', q4.id), 'mac');
  await engine.whenSettled();
  expect(engine.snapshot()).toMatchObject({ phase: 'DEGRADED_UNLOADED' });
  expect(engine.snapshot()).not.toHaveProperty('activeModel');
});

async function readyEngine(supervisor: FakeSupervisor, transitionScheduler?: DrainGate, drainTimeoutMs?: number): Promise<ManagerEngine> {
  const engine = new ManagerEngine({ catalog: [base, q4], supervisor, ...(transitionScheduler === undefined ? {} : { transitionScheduler }), ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }) });
  await engine.submit(operation('load', base.id), 'test');
  supervisor.releaseStart();
  await engine.whenSettled();
  supervisor.clearHistory();
  return engine;
}

function operation(action: 'load' | 'switch' | 'unload', model?: string, onBusy: 'reject' | 'queue' | 'force' = 'reject', idempotencyKey = randomUUID()): OperationRequest {
  return action === 'unload' ? { action, onBusy, idempotencyKey } : { action, model: model ?? q4.id, onBusy, idempotencyKey };
}

class FakeSupervisor {
  readonly starts: ModelSpec[] = [];
  readonly stops: string[] = [];
  readonly forceStops: string[] = [];
  #outcomes: Array<Error | undefined>;
  #startGate?: { resolve: () => void; promise: Promise<void> };
  #deferredStart?: { resolve: () => void; promise: Promise<void> };
  #deferredStop?: { resolve: () => void; promise: Promise<void> };
  stopEntered = deferred();
  #listeners = new Set<(event: ChildExitEvent) => void>();
  current?: ChildExitEvent['child'];
  activeChild = false;

  constructor(outcomes: Array<Error | undefined> = []) { this.#outcomes = outcomes; }
  async stop(reason: string): Promise<void> { this.stops.push(reason); this.stopEntered.resolve(); if (this.#deferredStop !== undefined) { await this.#deferredStop.promise; this.#deferredStop = undefined; } this.activeChild = false; }
  async forceStop(reason: string): Promise<void> { this.forceStops.push(reason); }
  async start(model: ModelSpec): Promise<ChildExitEvent['child']> {
    this.starts.push(model);
    const outcome = this.#outcomes.shift();
    if (outcome !== undefined) throw outcome;
    if (this.#startGate === undefined) this.#startGate = deferred();
    await this.#startGate.promise;
    if (this.#deferredStart !== undefined) { await this.#deferredStart.promise; this.#deferredStart = undefined; }
    this.activeChild = true;
    return this.current = Object.freeze({ model: model.id, pid: this.starts.length, startToken: String(this.starts.length) });
  }
  releaseStart(): void { this.#startGate?.resolve(); }
  clearHistory(): void { this.starts.length = 0; this.stops.length = 0; this.forceStops.length = 0; }
  onUnexpectedExit(listener: (event: ChildExitEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  emitExit(child: ChildExitEvent['child']): void { for (const listener of this.#listeners) listener(Object.freeze({ child })); }
  deferNextStart(): void { this.#deferredStart = deferred(); }
  releaseDeferredStart(): void { this.#deferredStart?.resolve(); }
  deferNextStop(): void { this.#deferredStop = deferred(); this.stopEntered = deferred(); }
  releaseDeferredStop(): void { this.#deferredStop?.resolve(); }
}

class DrainGate {
  readonly entered = deferred();
  #gate = deferred();
  beforeDrainCommit(): Promise<void> { this.entered.resolve(); return this.#gate.promise; }
  release(): void { this.#gate.resolve(); }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
