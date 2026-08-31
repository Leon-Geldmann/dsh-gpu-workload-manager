import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagerClient, ManagerClientError } from '../src/client.js';
import { parsePluginConfig } from '../src/config.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const MODEL = 'qwen3.8-27b-q4';
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('ManagerClient', () => {
  it('resolves the current credential separately for every operation and never returns it', async () => {
    const seen: Array<{ path: string; method: string; authorization: string | undefined; body: string }> = [];
    const origin = await serve(async (request, response) => {
      const body = await readBody(request);
      seen.push({ path: request.url!, method: request.method!, authorization: request.headers.authorization, body });
      if (request.url === '/gpu/v1/status') return send(response, 200, statusFixture());
      if (request.url === '/gpu/v1/models') return send(response, 200, modelsFixture());
      if (request.method === 'POST') return send(response, 202, { operation: operationFixture(JSON.parse(body)) });
      return send(response, 200, { operation: { ...operationFixture(), status: 'CANCELLED' } });
    });
    const resolved = [KEY_A, KEY_B, KEY_A, KEY_B];
    const refs: string[] = [];
    const client = new ManagerClient(parsePluginConfig({ role: 'server', managerUrl: origin, managementCredentialRef: 'GPU_MANAGER_KEY' }), {
      resolve: async (ref: unknown) => ({ value: resolved[refs.push(String(ref)) - 1]!, source: 'test' }),
    });
    const controller = new AbortController();
    const idempotencyKey = randomUUID();

    const status = await client.status(controller.signal);
    const models = await client.models(controller.signal);
    const submit = await client.submit({ action: 'switch', model: MODEL, onBusy: 'queue', idempotencyKey }, controller.signal);
    const cancel = await client.cancel('22222222-2222-4222-8222-222222222222', controller.signal);

    expect(status).toEqual(statusFixture());
    expect(models).toEqual(modelsFixture());
    expect(submit).toEqual({ kind: 'accepted', operation: operationFixture({ action: 'switch', model: MODEL, onBusy: 'queue', idempotencyKey }) });
    expect(cancel).toEqual({ kind: 'cancelled', operation: { ...operationFixture(), status: 'CANCELLED' } });
    expect(refs).toEqual(['GPU_MANAGER_KEY', 'GPU_MANAGER_KEY', 'GPU_MANAGER_KEY', 'GPU_MANAGER_KEY']);
    expect(seen.map(({ path, method, authorization }) => ({ path, method, authorization }))).toEqual([
      { path: '/gpu/v1/status', method: 'GET', authorization: `Bearer ${KEY_A}` },
      { path: '/gpu/v1/models', method: 'GET', authorization: `Bearer ${KEY_B}` },
      { path: '/gpu/v1/operations', method: 'POST', authorization: `Bearer ${KEY_A}` },
      { path: '/gpu/v1/operations/22222222-2222-4222-8222-222222222222', method: 'DELETE', authorization: `Bearer ${KEY_B}` },
    ]);
    expect(JSON.stringify({ status, models, submit, cancel })).not.toContain(KEY_A);
    expect(JSON.stringify({ status, models, submit, cancel })).not.toContain(KEY_B);
  });

  it('keeps local_model_busy details structured for the Web dialog', async () => {
    const origin = await serve((_request, response) => send(response, 409, {
      error: { code: 'local_model_busy', activeRequestCount: 3, activeModel: 'qwen3.8-27b', targetModel: MODEL },
    }));
    const client = makeClient(origin);
    await expect(client.submit({ action: 'switch', model: MODEL, onBusy: 'reject', idempotencyKey: randomUUID() }, new AbortController().signal)).resolves.toEqual({
      kind: 'busy', code: 'local_model_busy', activeRequestCount: 3, activeModel: 'qwen3.8-27b', targetModel: MODEL,
    });
  });

  it('rejects a partial model directory so the picker cannot silently lose a local model', async () => {
    const origin = await serve((_request, response) => send(response, 200, {
      object: 'list',
      data: [{ id: 'qwen3.8-27b', object: 'model', status: { value: 'unloaded' } }],
    }));
    await expect(makeClient(origin).models(new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('returns operation conflicts as data rather than exposing an upstream error', async () => {
    const origin = await serve((_request, response) => send(response, 409, { error: { code: 'operation_in_progress' } }));
    await expect(makeClient(origin).submit({ action: 'unload', onBusy: 'queue', idempotencyKey: randomUUID() }, new AbortController().signal)).resolves.toEqual({
      kind: 'conflict', code: 'operation_in_progress',
    });
  });

  it.each([
    { action: 'switch', model: 'not-catalogued', onBusy: 'queue', idempotencyKey: randomUUID() },
    { action: 'switch', model: MODEL, onBusy: 'queue', idempotencyKey: randomUUID().toUpperCase() },
    { action: 'unload', model: MODEL, onBusy: 'reject', idempotencyKey: randomUUID() },
    { action: 'load', model: MODEL, onBusy: 'surprise', idempotencyKey: randomUUID() },
  ])('rejects a non-canonical operation before making a request %#', async (request) => {
    let requests = 0;
    const origin = await serve((_incoming, response) => { requests += 1; send(response, 500, {}); });
    await expect(makeClient(origin).submit(request as never, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(requests).toBe(0);
  });

  it('fails closed on redirects, non-JSON responses, oversized bodies, and malformed JSON without leaking content', async () => {
    for (const reply of [
      { status: 302, headers: { location: 'http://127.0.0.1:9/stolen' }, body: '{}' },
      { status: 200, headers: { 'content-type': 'text/plain' }, body: 'sensitive upstream diagnostic' },
      { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(300_000) }) },
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"phase":' },
    ]) {
      const origin = await serve((_request, response) => {
        response.writeHead(reply.status, reply.headers);
        response.end(reply.body);
      });
      const caught = await makeClient(origin).status(new AbortController().signal).catch((error: unknown) => error);
      expect(caught).toMatchObject({ code: 'invalid_response', message: 'GPU Workload Manager 返回了无效响应' });
      expect(String(caught)).not.toContain('sensitive upstream diagnostic');
      expect(String(caught)).not.toContain(origin);
    }
  });

  it.each([
    [401, 'unauthorized', 'GPU Workload Manager 鉴权失败'],
    [503, 'unavailable', 'GPU Workload Manager 暂不可用'],
  ] as const)('classifies safe JSON HTTP failure %s without exposing its body', async (status, code, message) => {
    const origin = await serve((_request, response) => send(response, status, { error: { code: 'sensitive_upstream_detail', token: KEY_B } }));
    const caught = await makeClient(origin).status(new AbortController().signal).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code, message });
    expect(String(caught)).not.toContain('sensitive_upstream_detail');
    expect(String(caught)).not.toContain(KEY_B);
  });

  it('bounds the request deadline and observes caller cancellation', async () => {
    const origin = await serve(() => undefined);
    const client = makeClient(origin, 25);
    await expect(client.status(new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });

    const controller = new AbortController();
    const pending = client.status(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('does not send a mutation when cancellation lands between credential resolution and HTTP setup', async () => {
    let requests = 0;
    const origin = await serve((_request, response) => {
      requests += 1;
      send(response, 202, { operation: operationFixture() });
    });
    const controller = new AbortController();
    const client = new ManagerClient(
      parsePluginConfig({ role: 'server', managerUrl: origin, managementCredentialRef: 'GPU_MANAGER_KEY' }),
      {
        resolve: async () => ({
          get value() {
            queueMicrotask(() => controller.abort());
            return KEY_A;
          },
          source: 'test',
        }),
      },
    );

    const pending = client.submit({ action: 'unload', onBusy: 'reject', idempotencyKey: randomUUID() }, controller.signal);
    await expect(pending).rejects.toEqual(new ManagerClientError('aborted'));
    expect(requests).toBe(0);
  });

  it('uses a safe error when the referenced credential is absent or invalid', async () => {
    const origin = await serve((_request, response) => send(response, 200, statusFixture()));
    const absent = new ManagerClient(parsePluginConfig({ role: 'server', managerUrl: origin, managementCredentialRef: 'GPU_MANAGER_KEY' }), { resolve: async () => undefined });
    const invalid = new ManagerClient(parsePluginConfig({ role: 'server', managerUrl: origin, managementCredentialRef: 'GPU_MANAGER_KEY' }), { resolve: async () => ({ value: 'not-a-manager-key', source: 'test' }) });
    await expect(absent.status(new AbortController().signal)).rejects.toEqual(new ManagerClientError('credential_unavailable'));
    await expect(invalid.status(new AbortController().signal)).rejects.toEqual(new ManagerClientError('credential_unavailable'));
  });

  it('contains credential-provider failures and can abort while resolution is pending', async () => {
    const origin = await serve((_request, response) => send(response, 200, statusFixture()));
    const failing = new ManagerClient(
      parsePluginConfig({ role: 'server', managerUrl: origin, managementCredentialRef: 'GPU_MANAGER_KEY' }),
      { resolve: async () => { throw new Error(`sensitive credential path ${origin}`); } },
    );
    const caught = await failing.status(new AbortController().signal).catch((error: unknown) => error);
    expect(caught).toEqual(new ManagerClientError('credential_unavailable'));
    expect(String(caught)).not.toContain('sensitive credential path');
    expect(String(caught)).not.toContain(origin);

    const pending = new ManagerClient(
      parsePluginConfig({ role: 'server', managerUrl: origin, managementCredentialRef: 'GPU_MANAGER_KEY' }),
      { resolve: async () => await new Promise(() => undefined) },
      { timeoutMs: 5_000 },
    );
    const controller = new AbortController();
    const operation = pending.status(controller.signal);
    controller.abort();
    await expect(operation).rejects.toEqual(new ManagerClientError('aborted'));
  });
});

function makeClient(origin: string, timeoutMs = 5_000): ManagerClient {
  return new ManagerClient(
    parsePluginConfig({ role: 'server', managerUrl: origin, managementCredentialRef: 'GPU_MANAGER_KEY' }),
    { resolve: async () => ({ value: KEY_A, source: 'test' }) },
    { timeoutMs },
  );
}

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((request, response) => { void handler(request, response); });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;
  return body;
}

function statusFixture() {
  return { phase: 'READY' as const, activeModel: 'qwen3.8-27b', activeRequestCount: 0 };
}

function modelsFixture() {
  return {
    object: 'list' as const,
    data: [
      { id: 'qwen3.8-27b' as const, object: 'model' as const, status: { value: 'loaded' as const } },
      { id: 'qwen3.8-27b-uncensored' as const, object: 'model' as const, status: { value: 'unloaded' as const } },
      { id: 'qwen3.8-27b-q4' as const, object: 'model' as const, status: { value: 'unloaded' as const } },
      { id: 'qwen3.8-27b-uncensored-q4' as const, object: 'model' as const, status: { value: 'unloaded' as const } },
    ],
  };
}

function operationFixture(request = { idempotencyKey: '11111111-1111-4111-8111-111111111111', action: 'unload', onBusy: 'reject' }) {
  return { id: '22222222-2222-4222-8222-222222222222', request, status: 'RUNNING' as const };
}
