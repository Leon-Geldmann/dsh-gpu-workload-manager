import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { expect, it } from 'vitest';
import { createManagerServer } from '../src/server.js';
import { Metrics } from '../src/metrics.js';

const key = 'a'.repeat(64); const management = 'b'.repeat(64);
const catalogIds = ['qwen3.8-27b', 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4'];

it('does not contact the child for a rejected path or unloaded model', async () => {
  let upstreamRequests = 0;
  const child = createServer((_req, res) => { upstreamRequests += 1; res.end('bad'); }); child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const engine = fakeEngine({ phase: 'UNLOADED', activeRequestCount: 0 }); const server = gateway(engine, child); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await inference(server, '/v1/chat/completions?x=1', { model: catalogIds[0] })).status).toBe(400);
    expect((await inference(server, '/v1/chat/completions', { model: catalogIds[0] })).status).toBe(503);
    expect(upstreamRequests).toBe(0);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('streams only safe child response headers after atomic admission', async () => {
  const child = createServer((req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${key}`); expect(req.headers.host).toBe('127.0.0.1:18080');
    expect(req.headers['x-request-id']).toBe('client-safe');
    for (const name of ['cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'proxy-authorization', 'proxy-connection', 'accept', 'accept-encoding', 'x-secret']) expect(req.headers[name]).toBeUndefined();
    expect(Object.keys(req.headers).sort()).toEqual(['authorization', 'connection', 'content-length', 'content-type', 'host', 'x-request-id']);
    res.writeHead(200, { connection: 'x-request-id', 'content-type': 'text/event-stream', 'set-cookie': 'nope', 'www-authenticate': 'nope', server: 'private', 'x-request-id': 'child-secret' }); res.write('data: first\\n\\n'); res.end('data: last\\n\\n');
  }); child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const engine = fakeEngine({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 }); const server = gateway(engine, child); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const result = await inference(server, '/v1/responses', { model: catalogIds[0] }, { host: 'attacker.invalid', cookie: 'session=client-secret', forwarded: 'for=attacker', 'x-forwarded-for': 'attacker', 'x-forwarded-host': 'attacker', 'x-forwarded-proto': 'https', 'proxy-authorization': 'client-secret', 'proxy-connection': 'keep-alive', connection: 'cookie, forwarded, x-forwarded-for, proxy-authorization, proxy-connection', accept: 'text/private', 'accept-encoding': 'br', 'x-secret': 'client-secret', 'x-request-id': 'client-safe' });
    expect(result.status).toBe(200); expect(result.text).toContain('data: first'); expect(result.headers['set-cookie']).toBeUndefined(); expect(result.headers.server).toBeUndefined(); expect(result.headers['x-request-id']).toBeUndefined(); expect(engine.completed).toBe(1);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('measures TTFT only at the first generated Responses delta across SSE chunks', async () => {
  let clock = 0;
  const child = createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"status":"in_progress"}}\n\n');
    await delay(10); clock = 250;
    res.write('data: {"type":"response.output_text.delta","delta":"hel');
    await delay(10); clock = 500;
    res.write('lo"}\n\n');
    await delay(10); clock = 750;
    res.end('data: [DONE]\n\n');
  });
  child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const metrics = new Metrics(catalogIds, () => clock);
  const engine = fakeEngine({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 });
  const server = gateway(engine, child, metrics); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await inference(server, '/v1/responses', { model: catalogIds[0] })).status).toBe(200);
    const rendered = metrics.render(engine.snapshot() as never);
    expect(rendered).toContain(`manager_inference_ttft_seconds_sum{model="${catalogIds[0]}"} 0.5\n`);
    expect(rendered).toContain(`manager_inference_ttft_seconds_count{model="${catalogIds[0]}"} 1\n`);
    expect(rendered).toContain(`manager_inference_request_duration_seconds_sum{model="${catalogIds[0]}"} 0.75\n`);
    expect(rendered).toContain(`manager_inference_request_duration_seconds_count{model="${catalogIds[0]}"} 1\n`);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('does not report TTFT for role-only, lifecycle, DONE, or non-stream JSON responses', async () => {
  const child = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\ndata: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"already complete"}}]}');
  });
  child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const metrics = new Metrics(catalogIds, () => 1_000);
  const engine = fakeEngine({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 });
  const server = gateway(engine, child, metrics); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await inference(server, '/v1/chat/completions', { model: catalogIds[0], stream: true })).status).toBe(200);
    expect((await inference(server, '/v1/responses', { model: catalogIds[0] })).status).toBe(200);
    const rendered = metrics.render(engine.snapshot() as never);
    expect(rendered).toContain(`manager_inference_ttft_seconds_count{model="${catalogIds[0]}"} 0\n`);
    expect(rendered).toContain(`manager_inference_request_duration_seconds_count{model="${catalogIds[0]}"} 2\n`);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('recognizes generated deltas for Chat Completions and legacy Completions', async () => {
  const child = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url === '/v1/chat/completions') res.end('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n');
    else res.end('data: {"choices":[{"text":"answer"}]}\n\n');
  });
  child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const metrics = new Metrics(catalogIds, () => 1_000);
  const engine = fakeEngine({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 });
  const server = gateway(engine, child, metrics); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await inference(server, '/v1/chat/completions', { model: catalogIds[0], stream: true })).status).toBe(200);
    expect((await inference(server, '/v1/completions', { model: catalogIds[0], stream: true })).status).toBe(200);
    expect(metrics.render(engine.snapshot() as never)).toContain(`manager_inference_ttft_seconds_count{model="${catalogIds[0]}"} 2\n`);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('recognizes generated tool-call deltas for Chat Completions and Responses', async () => {
  const child = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url === '/v1/chat/completions') {
      res.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function"}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"city\\\":"}}]}}]}\n\n');
    } else {
      res.end('data: {"type":"response.function_call_arguments.delta","delta":"{\\\"city\\\":"}\n\n');
    }
  });
  child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const metrics = new Metrics(catalogIds, () => 1_000);
  const engine = fakeEngine({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 });
  const server = gateway(engine, child, metrics); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await inference(server, '/v1/chat/completions', { model: catalogIds[0], stream: true })).status).toBe(200);
    expect((await inference(server, '/v1/responses', { model: catalogIds[0], stream: true })).status).toBe(200);
    expect(metrics.render(engine.snapshot() as never)).toContain(`manager_inference_ttft_seconds_count{model="${catalogIds[0]}"} 2\n`);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('parses an initial UTF-8 BOM and mixed SSE line endings', async () => {
  const child = createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('data: {"type":"response.output_text.delta","delta":"token"}\r\n'),
    ]));
    await delay(10);
    res.end('\n');
  });
  child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const metrics = new Metrics(catalogIds, () => 1_000);
  const engine = fakeEngine({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 });
  const server = gateway(engine, child, metrics); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await inference(server, '/v1/responses', { model: catalogIds[0], stream: true })).status).toBe(200);
    expect(metrics.render(engine.snapshot() as never)).toContain(`manager_inference_ttft_seconds_count{model="${catalogIds[0]}"} 1\n`);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('dispatches an SSE event whose final blank line uses a trailing carriage return', async () => {
  const child = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"response.output_text.delta","delta":"token"}\r\r');
  });
  child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const metrics = new Metrics(catalogIds, () => 1_000);
  const engine = fakeEngine({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 });
  const server = gateway(engine, child, metrics); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await inference(server, '/v1/responses', { model: catalogIds[0], stream: true })).status).toBe(200);
    expect(metrics.render(engine.snapshot() as never)).toContain(`manager_inference_ttft_seconds_count{model="${catalogIds[0]}"} 1\n`);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('discards a generated SSE event that is not dispatched by a blank line before EOF', async () => {
  const child = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"response.output_text.delta","delta":"not-dispatched"}');
  });
  child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const metrics = new Metrics(catalogIds, () => 1_000);
  const engine = fakeEngine({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 });
  const server = gateway(engine, child, metrics); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await inference(server, '/v1/responses', { model: catalogIds[0], stream: true })).status).toBe(200);
    expect(metrics.render(engine.snapshot() as never)).toContain(`manager_inference_ttft_seconds_count{model="${catalogIds[0]}"} 0\n`);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('accepts an exact 64 KiB SSE event when its blank-line separator is split across chunks', async () => {
  const prefix = 'data: {"type":"response.output_text.delta","delta":"';
  const suffix = '"}';
  const event = `${prefix}${'x'.repeat(64 * 1024 - prefix.length - suffix.length)}${suffix}`;
  expect(event.length).toBe(64 * 1024);
  const child = createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event); await delay(10); res.write('\n'); await delay(10); res.end('\n');
  });
  child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const metrics = new Metrics(catalogIds, () => 1_000);
  const engine = fakeEngine({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 });
  const server = gateway(engine, child, metrics); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await inference(server, '/v1/responses', { model: catalogIds[0], stream: true })).status).toBe(200);
    expect(metrics.render(engine.snapshot() as never)).toContain(`manager_inference_ttft_seconds_count{model="${catalogIds[0]}"} 1\n`);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('bounds an oversized SSE event, recovers at its boundary, and forwards every byte unchanged', async () => {
  let clock = 0;
  const oversized = `data: ${'x'.repeat(80 * 1024)}\n\n`;
  const tokenStart = 'data: {"type":"response.reasoning_summary_text.delta","delta":"rea';
  const tokenEnd = 'son"}\n\n';
  const child = createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(oversized);
    await delay(10); clock = 250; res.write(tokenStart);
    await delay(10); clock = 500; res.end(tokenEnd);
  });
  child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const metrics = new Metrics(catalogIds, () => clock);
  const engine = fakeEngine({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 });
  const server = gateway(engine, child, metrics); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const result = await inference(server, '/v1/responses', { model: catalogIds[0], stream: true });
    expect(result.status).toBe(200); expect(result.text).toBe(oversized + tokenStart + tokenEnd);
    expect(metrics.render(engine.snapshot() as never)).toContain(`manager_inference_ttft_seconds_sum{model="${catalogIds[0]}"} 0.5\n`);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('finalizes a provisional resident lease exactly once on every body validation error', async () => {
  let upstreamRequests = 0;
  const child = createServer((_req, res) => { upstreamRequests += 1; res.end(); }); child.listen(0, '127.0.0.1'); await once(child, 'listening');
  const engine = fakeEngine({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 });
  const server = gateway(engine, child); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await inference(server, '/v1/responses', {})).status).toBe(400);
    expect((await inference(server, '/v1/responses', { model: 'not-in-catalog' })).status).toBe(404);
    expect((await inference(server, '/v1/responses', { model: catalogIds[1] })).status).toBe(409);
    expect((await inferenceBody(server, '/v1/responses', '{')).status).toBe(400);
    expect(engine.completed).toBe(4); expect(upstreamRequests).toBe(0);
  } finally { await server.shutdown(); await new Promise<void>((resolve) => child.close(() => resolve())); }
});

it('shuts down an active stream by aborting engine-owned work before awaiting server close', async () => {
  let releaseChild: (() => void) | undefined; const childStarted = Promise.withResolvers<void>();
  const child = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: open\\n\\n'); childStarted.resolve(); res.once('close', () => releaseChild?.()); }); child.listen(0, '127.0.0.1'); await once(child, 'listening');
  let abort: (() => void) | undefined; const engine = { snapshot: () => ({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 1 }), operations: () => [], submit: async () => { throw new Error('not_called'); }, cancel: () => ({ kind: 'conflict', code: 'operation_not_found' }), admitInference: () => ({ kind: 'admitted', lease: { id: 'stream', model: catalogIds[0], aborted: false, bindAbort: (callback: () => void) => { abort = callback; }, abort: () => abort?.(), complete: () => undefined } }), completeInference: () => undefined, shutdown: async () => { abort?.(); } };
  const server = gateway(engine, child); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  const client = request({ host: '127.0.0.1', port, path: '/v1/responses', method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }); client.on('error', () => undefined); client.end(JSON.stringify({ model: catalogIds[0] }));
  await childStarted.promise; const stopped = server.shutdown(); expect(server.shutdown()).toBe(stopped); await stopped; await new Promise<void>((resolve) => child.close(() => resolve()));
});

function fakeEngine(snapshot: { phase: string; activeModel?: string; activeRequestCount: number }) { let completed = 0; return { snapshot: () => snapshot, operations: () => [], submit: async () => { throw new Error('not_called'); }, cancel: () => ({ kind: 'conflict', code: 'operation_not_found' }), admitInference: (model: string) => snapshot.phase === 'READY' && snapshot.activeModel === model ? { kind: 'admitted', lease: { id: 'lease', model, aborted: false, bindAbort: () => undefined, abort: () => undefined, complete: () => { completed += 1; } } } : { kind: 'rejected', code: 'model_transition' }, completeInference: () => undefined, shutdown: async () => undefined, get completed() { return completed; } }; }
function gateway(engine: object, child: import('node:http').Server, metrics?: Metrics) { const port = (child.address() as import('node:net').AddressInfo).port; const rewrite = ((options: import('node:http').RequestOptions) => request({ ...options, port })) as typeof request; return createManagerServer({ inferenceKey: key, managementKey: management, childEndpoint: 'http://127.0.0.1:18080', catalogIds }, engine as never, { childRequest: rewrite, ...(metrics === undefined ? {} : { metrics }) }); }
function inference(server: import('node:http').Server, path: string, input: object, extraHeaders: Record<string, string> = {}): Promise<{ status: number; text: string; headers: import('node:http').IncomingHttpHeaders }> { const body = JSON.stringify(input); const port = (server.address() as import('node:net').AddressInfo).port; return new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), cookie: 'never-forward', ...extraHeaders } }, (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers })); }); req.on('error', reject); req.end(body); }); }
function inferenceBody(server: import('node:http').Server, path: string, body: string): Promise<{ status: number; text: string }> { const port = (server.address() as import('node:net').AddressInfo).port; return new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text })); }); req.on('error', reject); req.end(body); }); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
