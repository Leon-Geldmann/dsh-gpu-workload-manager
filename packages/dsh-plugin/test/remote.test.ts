import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GpuWorkloads from '../src/remote.js';

const KEY = 'c'.repeat(64);
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('GpuWorkloads Remote service', () => {
  it('exposes four generated-Remote source methods with structured secret-free values', async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const origin = await serve(async (request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      for await (const chunk of request) raw += chunk;
      requests.push({ path: request.url!, method: request.method!, body: raw === '' ? undefined : JSON.parse(raw) });
      if (request.url === '/gpu/v1/status') return json(response, 200, { phase: 'UNLOADED', activeRequestCount: 0 });
      if (request.url === '/gpu/v1/models') return json(response, 200, modelDirectory());
      if (request.method === 'POST') return json(response, 409, { error: { code: 'local_model_busy', activeRequestCount: 1, activeModel: 'qwen3.8-27b', targetModel: 'qwen3.8-27b-q4' } });
      return json(response, 409, { error: { code: 'operation_not_cancellable' } });
    });
    const resolve = vi.fn(async () => ({ value: KEY, source: 'test' }));
    const ctx = new Context();
    ctx.provide('commands', { register: () => () => undefined } as never);
    ctx.provide('credentials', { resolve } as never);
    await ctx.plugin(GpuWorkloads, { role: 'server', managerUrl: origin, managementCredentialRef: 'GPU_MANAGER_KEY' });
    const signal = new AbortController().signal;
    const idempotencyKey = randomUUID();

    expect(remoteMethods(ctx.gpuWorkloads).map(({ method, invocation }) => ({ method, invocation }))).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'models', invocation: { kind: 'direct' } },
      { method: 'submit', invocation: { kind: 'direct' } },
      { method: 'cancel', invocation: { kind: 'direct' } },
    ]);
    const status = await ctx.gpuWorkloads.status(signal);
    const models = await ctx.gpuWorkloads.models(signal);
    const busy = await ctx.gpuWorkloads.submit({ action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'reject', idempotencyKey }, signal);
    const cancel = await ctx.gpuWorkloads.cancel('22222222-2222-4222-8222-222222222222', signal);

    expect(status).toEqual({ phase: 'UNLOADED', activeRequestCount: 0 });
    expect(models).toEqual(modelDirectory());
    expect(busy).toEqual({ kind: 'busy', code: 'local_model_busy', activeRequestCount: 1, activeModel: 'qwen3.8-27b', targetModel: 'qwen3.8-27b-q4' });
    expect(cancel).toEqual({ kind: 'conflict', code: 'operation_not_cancellable' });
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(JSON.stringify({ status, models, busy, cancel })).not.toContain(KEY);
    expect(requests).toEqual([
      { path: '/gpu/v1/status', method: 'GET', body: undefined },
      { path: '/gpu/v1/models', method: 'GET', body: undefined },
      { path: '/gpu/v1/operations', method: 'POST', body: { action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'reject', idempotencyKey } },
      { path: '/gpu/v1/operations/22222222-2222-4222-8222-222222222222', method: 'DELETE', body: undefined },
    ]);
  });
});

async function serve(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function modelDirectory() {
  return {
    object: 'list',
    data: [
      { id: 'qwen3.8-27b', object: 'model', status: { value: 'unloaded' } },
      { id: 'qwen3.8-27b-uncensored', object: 'model', status: { value: 'unloaded' } },
      { id: 'qwen3.8-27b-q4', object: 'model', status: { value: 'unloaded' } },
      { id: 'qwen3.8-27b-uncensored-q4', object: 'model', status: { value: 'unloaded' } },
    ],
  };
}
