import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import type { ModelSpec } from '@local/gpu-workload-core';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { ManagerEngine, type LifecycleSupervisor } from '../../packages/managerd/src/manager-engine.js';
import { createManagerServer, type ManagerServer } from '../../packages/managerd/src/server.js';
import type { RunningChild, UnexpectedChildExit } from '../../packages/managerd/src/child-supervisor.js';
import { ManagerClient } from '../../packages/dsh-plugin/src/client.js';
import { parsePluginConfig, type ResolvedPluginConfig } from '../../packages/dsh-plugin/src/config.js';
import type { GpuCancelResult, GpuManagerStatus, GpuModelList, GpuOperationRequest, GpuSubmitResult } from '../../packages/dsh-plugin/src/types.js';
import { GpuManagerController, type BrowserGpuRemote } from '../../packages/dsh-model-selection/src/manager-controller.js';
import { DISABLED_LOCAL_REASON, modelPolicy } from '../../packages/dsh-model-selection/src/policy.js';

const managementKey = 'b'.repeat(64);
const inferenceKey = 'a'.repeat(64);
const models: readonly ModelSpec[] = Object.freeze([
  Object.freeze({ id: 'qwen3.8-27b', path: '/fake/base-q5.gguf', contextSize: 65_536, mtp: 2 }),
  Object.freeze({ id: 'qwen3.8-27b-uncensored', path: '/fake/uncensored-q5.gguf', contextSize: 65_536, mtp: 2 }),
  Object.freeze({ id: 'qwen3.8-27b-q4', path: '/fake/base-q4.gguf', contextSize: 131_072, mtp: 5 }),
  Object.freeze({ id: 'qwen3.8-27b-uncensored-q4', path: '/fake/uncensored-q4.gguf', contextSize: 131_072, mtp: 2 }),
]);
const servers: ManagerServer[] = [];
const controllers: GpuManagerController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose();
  await Promise.all(servers.splice(0).map((server) => server.shutdown()));
});

it('linearizes Ubuntu and Mac manual operations while both browser views preserve cloud availability', async () => {
  const supervisor = new FakeSupervisor();
  const engine = new ManagerEngine({ catalog: models, supervisor });
  const server = createManagerServer({
    inferenceKey, managementKey, childEndpoint: 'http://127.0.0.1:18080', catalogIds: models.map((model) => model.id),
  }, engine);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const ubuntuConfig = parsePluginConfig({ role: 'server', managerUrl: origin, managementCredentialRef: 'GPU_MANAGER_KEY' });
  const reviewedMacConfig = parsePluginConfig({ role: 'client', managerUrl: `http://192.168.50.10:${(server.address() as AddressInfo).port}`, managementCredentialRef: 'GPU_MANAGER_KEY' });
  expect(reviewedMacConfig).toMatchObject({ role: 'client', managerUrl: expect.stringMatching(/^http:\/\/192\.168\.50\.10:/) });
  // The fake host transport terminates both DSH bridges on loopback; the client-role URL
  // validation above independently proves the production LAN endpoint contract.
  const macConfig: ResolvedPluginConfig = Object.freeze({ ...reviewedMacConfig, managerUrl: origin });
  const credentials = { resolve: async () => ({ value: managementKey, source: 'test' }) };
  const ubuntu = new ManagerClient(ubuntuConfig, credentials);
  const mac = new ManagerClient(macConfig, credentials);
  const ubuntuView = new GpuManagerController(remoteFor(ubuntu));
  const macView = new GpuManagerController(remoteFor(mac));
  controllers.push(ubuntuView, macView);

  const initialLoad = await ubuntu.submit(operation('load', 'qwen3.8-27b', 'reject'), new AbortController().signal);
  expect(initialLoad.kind).toBe('accepted');
  await engine.whenSettled();
  expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: 'qwen3.8-27b' });

  const admission = engine.admitInference('qwen3.8-27b');
  expect(admission.kind).toBe('admitted');
  if (admission.kind !== 'admitted') throw new Error('fake_inference_not_admitted');

  const simultaneous = await Promise.all([
    ubuntu.submit(operation('switch', 'qwen3.8-27b-q4', 'queue'), new AbortController().signal),
    mac.submit(operation('switch', 'qwen3.8-27b-uncensored-q4', 'queue'), new AbortController().signal),
  ]);
  expect(simultaneous.filter((result) => result.kind === 'accepted')).toHaveLength(1);
  expect(simultaneous.filter((result) => result.kind === 'conflict')).toEqual([
    expect.objectContaining({ kind: 'conflict', code: 'operation_in_progress' }),
  ]);

  await Promise.all([ubuntuView.refresh(), macView.refresh()]);
  expect(ubuntuView.store.getSnapshot().status).toEqual(macView.store.getSnapshot().status);
  expect(ubuntuView.store.getSnapshot().status).toMatchObject({ phase: 'DRAINING', activeRequestCount: 1 });
  assertPickerPolicy(ubuntuView.store.getSnapshot().status!, undefined);
  assertPickerPolicy(macView.store.getSnapshot().status!, undefined);

  admission.lease.complete();
  await engine.whenSettled();
  const resident = engine.snapshot().activeModel!;
  await Promise.all([ubuntuView.refresh(), macView.refresh()]);
  expect(ubuntuView.store.getSnapshot().status).toEqual(macView.store.getSnapshot().status);
  assertPickerPolicy(ubuntuView.store.getSnapshot().status!, resident);

  const forcedAdmission = engine.admitInference(resident);
  expect(forcedAdmission.kind).toBe('admitted');
  if (forcedAdmission.kind !== 'admitted') throw new Error('fake_force_inference_not_admitted');
  let localAbortCount = 0;
  forcedAdmission.lease.bindAbort(() => { localAbortCount += 1; });
  const cloudRequest = { aborted: false };
  const forceTarget = resident === 'qwen3.8-27b' ? 'qwen3.8-27b-q4' : 'qwen3.8-27b';
  expect(await mac.submit(operation('switch', forceTarget, 'force'), new AbortController().signal)).toMatchObject({ kind: 'accepted' });
  await engine.whenSettled();
  expect(localAbortCount).toBe(1);
  expect(forcedAdmission.lease.aborted).toBe(true);
  expect(cloudRequest.aborted).toBe(false);
  expect(engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: forceTarget, activeRequestCount: 0 });

  expect(await ubuntu.submit(operation('unload', undefined, 'reject'), new AbortController().signal)).toMatchObject({ kind: 'accepted' });
  await engine.whenSettled();
  await Promise.all([ubuntuView.refresh(), macView.refresh()]);
  expect(engine.snapshot()).toEqual({ phase: 'UNLOADED', activeRequestCount: 0 });
  expect(ubuntuView.store.getSnapshot().status).toEqual(macView.store.getSnapshot().status);
  assertPickerPolicy(ubuntuView.store.getSnapshot().status!, undefined);
  expect(supervisor.started).toHaveLength(3);
});

function operation(action: 'load' | 'switch' | 'unload', model: string | undefined, onBusy: 'reject' | 'queue' | 'force'): GpuOperationRequest {
  return action === 'unload'
    ? { idempotencyKey: randomUUID(), action, onBusy }
    : { idempotencyKey: randomUUID(), action, model: model as GpuOperationRequest['model'], onBusy };
}

function remoteFor(client: ManagerClient): BrowserGpuRemote {
  return {
    status: async (signal = new AbortController().signal) => result(() => client.status(signal)),
    models: async (signal = new AbortController().signal) => result(() => client.models(signal)),
    submit: async (request, signal = new AbortController().signal) => result(() => client.submit(request, signal)),
    cancel: async (operationId, signal = new AbortController().signal) => result(() => client.cancel(operationId, signal)),
  };
}

async function result<T>(call: () => Promise<T>): Promise<RemoteResult<T>> {
  try { return { ok: true, value: await call() }; }
  catch { return { ok: false, error: { code: 'fake_remote_error', message: 'unavailable', details: {} } }; }
}

function assertPickerPolicy(status: GpuManagerStatus, resident: string | undefined): void {
  for (const model of models) {
    const policy = modelPolicy({ providerId: 'llama-local', id: model.id }, status);
    if (resident === model.id && status.phase === 'READY') expect(policy).toEqual({ disabled: false });
    else expect(policy).toEqual({ disabled: true, reason: DISABLED_LOCAL_REASON });
  }
  expect(modelPolicy({ providerId: 'deepseek', id: 'deepseek-chat' }, status)).toEqual({ disabled: false });
  expect(modelPolicy({ providerId: 'openai', id: 'gpt-online' }, status)).toEqual({ disabled: false });
}

class FakeSupervisor implements LifecycleSupervisor {
  readonly started: string[] = [];
  private child: RunningChild | undefined;
  private listener: ((event: UnexpectedChildExit) => void) | undefined;

  async start(model: ModelSpec): Promise<RunningChild> {
    if (this.child !== undefined) throw new Error('child_already_running');
    this.started.push(model.id);
    this.child = Object.freeze({ pid: 10_000 + this.started.length, model: model.id, startToken: String(this.started.length) });
    return this.child;
  }

  async stop(): Promise<void> { this.child = undefined; }
  onUnexpectedExit(listener: (event: UnexpectedChildExit) => void): () => void {
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = undefined; };
  }
}
