import { once } from 'node:events';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { Metrics } from '../src/metrics.js';
import { createManagerServer, type ManagerServer } from '../src/server.js';

const inferenceKey = 'a'.repeat(64); const managementKey = 'b'.repeat(64);
const model = 'qwen3.8-27b';
const catalogIds = [model, 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4'];

it('enforces an absolute deadline for child response headers and finalizes once', async () => {
  const childStarted = Promise.withResolvers<void>();
  const fixture = await gateway((_request, _response) => { childStarted.resolve(); }, { childConnectHeadersTimeoutMs: 20, streamIdleTimeoutMs: 100, totalRequestTimeoutMs: 500 });
  try {
    const responsePromise = inference(fixture.server);
    await childStarted.promise;
    const result = await responsePromise;
    expect(result).toMatchObject({ status: 502, aborted: false });
    expect(result.text).toBe('{"error":{"code":"upstream_unavailable"}}');
    await expectSettled(fixture);
  } finally { await fixture.close(); }
});

it('keeps a legal sparse stream alive after the old child-header deadline', async () => {
  const fixture = await gateway(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
    await delay(25); response.write('data: one\n\n');
    await delay(25); response.end('data: two\n\n');
  }, { childConnectHeadersTimeoutMs: 10, streamIdleTimeoutMs: 60, totalRequestTimeoutMs: 500 });
  try {
    const result = await inference(fixture.server);
    expect(result).toMatchObject({ status: 200, aborted: false });
    expect(result.text).toBe('data: one\n\ndata: two\n\n');
    await expectSettled(fixture);
  } finally { await fixture.close(); }
});

it('aborts a stream that makes no progress before the idle deadline', async () => {
  const upstreamClosed = Promise.withResolvers<void>();
  const fixture = await gateway((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); response.write('data: first\n\n');
    response.once('close', () => upstreamClosed.resolve());
  }, { childConnectHeadersTimeoutMs: 50, streamIdleTimeoutMs: 20, totalRequestTimeoutMs: 500 });
  try {
    const result = await inference(fixture.server);
    expect(result.status).toBe(200);
    expect(result.aborted).toBe(true);
    await upstreamClosed.promise;
    await expectSettled(fixture);
  } finally { await fixture.close(); }
});

it('enforces the total request deadline even while the child keeps making progress', async () => {
  let writes = 0;
  const fixture = await gateway((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
    const progress = setInterval(() => { writes += 1; response.write(`data: ${writes}\n\n`); }, 5); progress.unref();
    response.once('close', () => clearInterval(progress));
  }, { childConnectHeadersTimeoutMs: 20, streamIdleTimeoutMs: 20, totalRequestTimeoutMs: 50 });
  try {
    const result = await inference(fixture.server);
    expect(result.status).toBe(200); expect(result.aborted).toBe(true);
    expect(writes).toBeGreaterThan(2);
    await expectSettled(fixture);
  } finally { await fixture.close(); }
});

it('maps child non-2xx responses to a generic 502 without body or header leakage', async () => {
  const fixture = await gateway((_request, response) => {
    response.writeHead(401, { 'content-type': 'text/plain', 'set-cookie': 'session=child-secret', 'www-authenticate': 'Bearer child-secret', 'x-request-id': 'child-secret' });
    response.end('child-secret diagnostic');
  });
  try {
    const result = await inference(fixture.server);
    expect(result).toMatchObject({ status: 502, aborted: false });
    expect(result.text).toBe('{"error":{"code":"upstream_unavailable"}}');
    expect(result.text).not.toContain('child-secret');
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers['www-authenticate']).toBeUndefined();
    expect(result.headers['x-request-id']).toBeUndefined();
    await expectSettled(fixture);
  } finally { await fixture.close(); }
});

it('aborts the child and finalizes once when downstream disconnects before headers', async () => {
  const childStarted = Promise.withResolvers<void>(); const upstreamClosed = Promise.withResolvers<void>();
  const fixture = await gateway((request, response) => {
    childStarted.resolve();
    const closed = () => upstreamClosed.resolve(); request.once('aborted', closed); response.once('close', closed);
  });
  try {
    const client = beginInference(fixture.server); client.on('error', () => undefined);
    await childStarted.promise; client.destroy();
    await upstreamClosed.promise;
    await expectSettled(fixture);
  } finally { await fixture.close(); }
});

it('aborts the child and finalizes once when downstream disconnects mid-SSE', async () => {
  const upstreamClosed = Promise.withResolvers<void>();
  const fixture = await gateway((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: open\n\n');
    response.once('close', () => upstreamClosed.resolve());
  });
  try {
    const received = Promise.withResolvers<void>();
    const client = beginInference(fixture.server, (response) => {
      response.once('data', () => { response.destroy(); client.destroy(); received.resolve(); });
    });
    client.on('error', () => undefined);
    await received.promise; await upstreamClosed.promise;
    await expectSettled(fixture);
  } finally { await fixture.close(); }
});

it('returns a generic 502 and finalizes once when upstream resets before headers', async () => {
  const fixture = await gateway((request) => { request.socket.destroy(); });
  try {
    const result = await inference(fixture.server);
    expect(result).toMatchObject({ status: 502, aborted: false });
    expect(result.text).toBe('{"error":{"code":"upstream_unavailable"}}');
    await expectSettled(fixture);
  } finally { await fixture.close(); }
});

it('closes the downstream and finalizes once when upstream resets after headers', async () => {
  let upstreamResponse: ServerResponse | undefined;
  const fixture = await gateway((_request, response) => {
    upstreamResponse = response;
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); response.write('data: partial\n\n');
  });
  try {
    const result = await inference(fixture.server, () => upstreamResponse?.socket?.destroy());
    expect(result.status).toBe(200);
    expect(result.aborted).toBe(true);
    await expectSettled(fixture);
  } finally { await fixture.close(); }
});

it('preserves pipeline backpressure for a paused slow reader', async () => {
  const bytes = 2 * 1024 * 1024; let backpressure = 0;
  const fixture = await gateway(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    for (let written = 0; written < bytes; written += chunk.length) {
      if (!response.write(chunk)) { backpressure += 1; await once(response, 'drain'); }
    }
    response.end();
  });
  try {
    const result = await inference(fixture.server, (response) => {
      response.pause(); setTimeout(() => response.resume(), 25).unref();
    });
    expect(result).toMatchObject({ status: 200, aborted: false });
    expect(Buffer.byteLength(result.text)).toBe(bytes);
    expect(backpressure).toBeGreaterThan(0);
    await expectSettled(fixture);
  } finally { await fixture.close(); }
});

it('shuts down an active SSE exactly once across repeated callers and cleans every owned resource', async () => {
  const upstreamClosed = Promise.withResolvers<void>(); const downstreamStarted = Promise.withResolvers<void>();
  const fixture = await gateway((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: open\n\n');
    response.once('close', () => upstreamClosed.resolve());
  });
  let closed = false;
  try {
    const result = inference(fixture.server, () => downstreamStarted.resolve());
    await downstreamStarted.promise;
    const first = fixture.server.shutdown(); const repeated = fixture.server.shutdown();
    expect(repeated).toBe(first);
    await first;
    expect((await result).aborted).toBe(true);
    await upstreamClosed.promise; await fixture.completed;
    expect(fixture.shutdowns()).toBe(1); expect(fixture.aborts()).toBe(1); expect(fixture.completions()).toBe(1);
    expect(fixture.metricsSnapshot()).toContain('manager_gateway_requests_total 1\nmanager_gateway_active_requests 0\n');
    expect(fixture.server.address()).toBeNull();
    await fixture.close(); closed = true;
    expect(fixture.childAddress()).toBeNull();
  } finally { if (!closed) await fixture.close(); }
});

interface Fixture {
  readonly server: ManagerServer;
  readonly completions: () => number;
  readonly completed: Promise<void>;
  readonly shutdowns: () => number;
  readonly aborts: () => number;
  readonly metricsSnapshot: () => string;
  readonly childAddress: () => ReturnType<import('node:http').Server['address']>;
  metrics(): Promise<string>;
  close(): Promise<void>;
}

async function gateway(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, limits: Record<string, number> = {}): Promise<Fixture> {
  const child = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(() => response.destroy()); });
  child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const childPort = (child.address() as import('node:net').AddressInfo).port;
  let completeCount = 0; let shutdownCount = 0; let abortCount = 0; let abort: (() => void) | undefined; const completed = Promise.withResolvers<void>(); const metrics = new Metrics();
  const engine = {
    snapshot: () => ({ phase: 'READY', activeModel: model, activeRequestCount: completeCount === 0 ? 1 : 0 }), operations: () => [],
    submit: async () => { throw new Error('not_called'); }, cancel: () => ({ kind: 'conflict', code: 'operation_not_found' }),
    admitInference: () => ({ kind: 'admitted', lease: { id: 'lease', model, aborted: false, bindAbort: (callback: () => void) => { abort = callback; }, abort: () => abort?.(), complete: () => { completeCount += 1; completed.resolve(); } } }),
    completeInference: () => undefined, shutdown: async () => { shutdownCount += 1; abortCount += 1; abort?.(); },
  };
  const rewrite = ((options: import('node:http').RequestOptions) => request({ ...options, port: childPort })) as typeof request;
  const server = createManagerServer({ inferenceKey, managementKey, childEndpoint: 'http://127.0.0.1:18080', catalogIds, limits }, engine as never, { childRequest: rewrite, metrics });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    server, completions: () => completeCount, completed: completed.promise, shutdowns: () => shutdownCount, aborts: () => abortCount,
    metricsSnapshot: () => metrics.render(engine.snapshot() as never), childAddress: () => child.address(),
    metrics: () => getMetrics(server),
    close: async () => { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); },
  };
}

async function expectSettled(fixture: Fixture): Promise<void> {
  await fixture.completed;
  expect(fixture.completions()).toBe(1);
  const metrics = await fixture.metrics();
  expect(metrics).toContain('manager_gateway_requests_total 1\n');
  expect(metrics).toContain('manager_gateway_active_requests 0\n');
}

function inference(server: ManagerServer, onResponse?: (response: IncomingMessage) => void): Promise<{ status: number; text: string; headers: import('node:http').IncomingHttpHeaders; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: { status: number; text: string; headers: import('node:http').IncomingHttpHeaders; aborted: boolean }) => { if (!settled) { settled = true; resolve(value); } };
    const client = beginInference(server, (response) => {
      onResponse?.(response); let text = ''; response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => finish({ status: response.statusCode ?? 0, text, headers: response.headers, aborted: false }));
      response.on('aborted', () => finish({ status: response.statusCode ?? 0, text, headers: response.headers, aborted: true }));
      response.on('error', () => finish({ status: response.statusCode ?? 0, text, headers: response.headers, aborted: true }));
      response.on('close', () => { if (!response.complete) finish({ status: response.statusCode ?? 0, text, headers: response.headers, aborted: true }); });
    });
    client.on('error', (error) => settled ? undefined : reject(error));
  });
}

function beginInference(server: ManagerServer, onResponse?: (response: IncomingMessage) => void) {
  const body = JSON.stringify({ model }); const port = (server.address() as import('node:net').AddressInfo).port;
  const client = request({ host: '127.0.0.1', port, path: '/v1/responses', method: 'POST', headers: { authorization: `Bearer ${inferenceKey}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, onResponse);
  client.end(body); return client;
}

function getMetrics(server: ManagerServer): Promise<string> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port, path: '/metrics', headers: { authorization: `Bearer ${managementKey}` } }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve(text));
    }); client.on('error', reject); client.end();
  });
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
