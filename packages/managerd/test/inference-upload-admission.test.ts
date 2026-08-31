import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request, type ClientRequest } from 'node:http';
import { expect, it } from 'vitest';
import type { ModelSpec, OperationRequest } from '@local/gpu-workload-core';
import { ManagerEngine, type ChildExitEvent } from '../src/manager-engine.js';
import { createManagerServer, type ManagerServer } from '../src/server.js';

const inferenceKey = 'a'.repeat(64); const managementKey = 'b'.repeat(64);
const base: ModelSpec = { id: 'qwen3.8-27b', path: '/catalog/base.gguf', contextSize: 8192, mtp: 0 };
const uncensored: ModelSpec = { id: 'qwen3.8-27b-uncensored', path: '/catalog/uncensored.gguf', contextSize: 8192, mtp: 0 };
const q4: ModelSpec = { id: 'qwen3.8-27b-q4', path: '/catalog/q4.gguf', contextSize: 8192, mtp: 0 };
const uncensoredQ4: ModelSpec = { id: 'qwen3.8-27b-uncensored-q4', path: '/catalog/uncensored-q4.gguf', contextSize: 8192, mtp: 0 };
const catalog = [base, uncensored, q4, uncensoredQ4] as const;

it('admits a partial upload before JSON completion and rejects a second request at maximumActive one', async () => {
  const fixture = await gateway();
  try {
    const slow = partialUpload(fixture.server);
    await waitFor(() => fixture.engine.snapshot().activeRequestCount === 1);

    const second = await inference(fixture.server, { model: base.id });
    expect(second).toEqual({ status: 409, text: '{"error":{"code":"local_model_busy"}}' });
    expect(fixture.upstreamRequests()).toBe(0);

    slow.client.destroy(); await slow.closed;
    await waitFor(() => fixture.engine.snapshot().activeRequestCount === 0);
  } finally { await fixture.close(); }
});

it('keeps a queued unload draining until a partial upload disconnects', async () => {
  const fixture = await gateway();
  try {
    const slow = partialUpload(fixture.server);
    await waitFor(() => fixture.engine.snapshot().activeRequestCount === 1);

    const queued = await fixture.engine.submit(operation('unload', undefined, 'queue'), 'test');
    expect(queued).toMatchObject({ kind: 'accepted', operation: { status: 'QUEUED' } });
    expect(fixture.engine.snapshot()).toMatchObject({ phase: 'DRAINING', activeRequestCount: 1 });
    expect(fixture.supervisor.stops).toEqual([]);

    slow.client.destroy(); await slow.closed; await fixture.engine.whenSettled();
    expect(fixture.engine.snapshot()).toMatchObject({ phase: 'UNLOADED', activeRequestCount: 0 });
    expect(fixture.supervisor.stops).toEqual(['unload']);
  } finally { await fixture.close(); }
});

it('force-switch aborts a partial upload before replacing the resident model', async () => {
  const fixture = await gateway();
  try {
    const slow = partialUpload(fixture.server);
    await waitFor(() => fixture.engine.snapshot().activeRequestCount === 1);

    await expect(fixture.engine.submit(operation('switch', q4.id, 'force'), 'test')).resolves.toMatchObject({ kind: 'accepted' });
    await Promise.race([slow.closed, delay(250).then(() => { throw new Error('partial_upload_not_aborted'); })]);
    await fixture.engine.whenSettled();
    expect(fixture.engine.snapshot()).toMatchObject({ phase: 'READY', activeModel: q4.id, activeRequestCount: 0 });
    expect(fixture.upstreamRequests()).toBe(0);
  } finally { await fixture.close(); }
});

interface Fixture {
  readonly server: ManagerServer;
  readonly engine: ManagerEngine;
  readonly supervisor: ImmediateSupervisor;
  upstreamRequests(): number;
  close(): Promise<void>;
}

async function gateway(): Promise<Fixture> {
  let upstreamRequests = 0;
  const child = createServer((_request, response) => { upstreamRequests += 1; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'); });
  child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const childPort = (child.address() as import('node:net').AddressInfo).port;
  const supervisor = new ImmediateSupervisor();
  const engine = new ManagerEngine({ catalog, supervisor });
  await engine.submit(operation('load', base.id), 'test'); await engine.whenSettled(); supervisor.stops.length = 0;
  const childRequest = ((options: import('node:http').RequestOptions) => request({ ...options, port: childPort })) as typeof request;
  const server = createManagerServer({ inferenceKey, managementKey, childEndpoint: 'http://127.0.0.1:18080', catalogIds: catalog.map((model) => model.id) }, engine, { childRequest });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, engine, supervisor, upstreamRequests: () => upstreamRequests, close: async () => { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); } };
}

function partialUpload(server: ManagerServer): { client: ClientRequest; closed: Promise<void> } {
  const body = JSON.stringify({ model: base.id, prompt: 'slow' });
  const port = (server.address() as import('node:net').AddressInfo).port;
  const closed = Promise.withResolvers<void>();
  const client = request({ host: '127.0.0.1', port, path: '/v1/responses', method: 'POST', headers: { authorization: `Bearer ${inferenceKey}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => { response.resume(); response.once('close', () => closed.resolve()); });
  client.once('error', () => closed.resolve()); client.once('close', () => closed.resolve());
  client.write(body.slice(0, 1));
  return { client, closed: closed.promise };
}

function inference(server: ManagerServer, input: object): Promise<{ status: number; text: string }> {
  const body = JSON.stringify(input); const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port, path: '/v1/responses', method: 'POST', headers: { authorization: `Bearer ${inferenceKey}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
    }); client.on('error', reject); client.end(body);
  });
}

function operation(action: 'load' | 'switch' | 'unload', model?: string, onBusy: 'reject' | 'queue' | 'force' = 'reject'): OperationRequest {
  return action === 'unload' ? { action, onBusy, idempotencyKey: randomUUID() } : { action, model, onBusy, idempotencyKey: randomUUID() };
}
function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => { const deadline = Date.now() + 1_000; const poll = () => { if (predicate()) return resolve(); if (Date.now() >= deadline) return reject(new Error('condition_timeout')); setTimeout(poll, 5).unref(); }; poll(); });
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

class ImmediateSupervisor {
  readonly stops: string[] = [];
  #sequence = 0;
  async start(model: ModelSpec): Promise<ChildExitEvent['child']> { this.#sequence += 1; return Object.freeze({ model: model.id, pid: this.#sequence, startToken: String(this.#sequence) }); }
  async stop(reason: string): Promise<void> { this.stops.push(reason); }
  onUnexpectedExit(): () => void { return () => undefined; }
}
