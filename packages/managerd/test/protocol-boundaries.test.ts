import { once } from 'node:events';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { expect, it } from 'vitest';
import { createManagerServer } from '../src/server.js';

const inferenceKey = 'a'.repeat(64); const managementKey = 'b'.repeat(64);
const catalogIds = ['qwen3.8-27b', 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4'];

it('rejects raw protocol events without interim responses or admission', async () => {
  const fixture = await gateway();
  try {
    for (const wire of [
      inferenceWire('Expect: 100-continue\r\n', 'Content-Length: 5\r\n', ''),
      inferenceWire('Expect: unsupported\r\n', 'Content-Length: 5\r\n', ''),
      'GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      'CONNECT / HTTP/1.1\r\nHost: x\r\n\r\n',
      `GET /v1/models HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${inferenceKey}\r\nAuthorization: Bearer ${inferenceKey}\r\n\r\n`,
      inferenceWire('Connection: x-request-id\r\nX-Request-Id: x\r\n', 'Content-Length: 2\r\n', '{}'),
    ]) {
      const response = await raw(fixture.port, wire);
      expect(response).toMatch(/Cache-Control: no-store/i);
      expect(response).toMatch(/Connection: close/i);
      expect(response).not.toMatch(/100 Continue/);
    }
    expect(fixture.admissions()).toBe(0);
    expect(fixture.upstreamRequests()).toBe(0);
  } finally { await fixture.server.shutdown(); }
});

it('returns generic no-store close responses for parser errors and header overflow', async () => {
  const fixture = await gateway();
  try {
    const cases = [
      { wire: inferenceWire('Content-Length: 2\r\nContent-Length: 2\r\n', '', '{}'), status: 400 },
      { wire: inferenceWire('Content-Length: 2\r\nTransfer-Encoding: chunked\r\n', '', '2\r\n{}\r\n0\r\n\r\n'), status: 400 },
      { wire: 'GET /health HTTP/1.1\r\nHost: x\r\nBad Header: x\r\n\r\n', status: 400 },
      { wire: `GET /health HTTP/1.1\r\nHost: x\r\nX-Fill: ${'x'.repeat(20 * 1024)}\r\n\r\n`, status: 431 },
    ];
    for (const entry of cases) {
      const response = await raw(fixture.port, entry.wire);
      expect(response).toMatch(new RegExp(`^HTTP/1\\.1 ${entry.status}`));
      expect(response).toMatch(/Cache-Control: no-store/i);
      expect(response).toMatch(/Connection: close/i);
      expect(response).not.toContain(inferenceKey);
    }
    expect(fixture.admissions()).toBe(0);
    expect(fixture.upstreamRequests()).toBe(0);
  } finally { await fixture.server.shutdown(); }
});

it('accepts exactly 64 raw headers and rejects the 65th before routing', async () => {
  const fixture = await gateway();
  try {
    const headers = (count: number) => Array.from({ length: count }, (_, index) => `X-${index}: x\r\n`).join('');
    const atLimit = await raw(fixture.port, `GET /health HTTP/1.1\r\nHost: x\r\n${headers(63)}\r\n`);
    expect(atLimit).toMatch(/^HTTP\/1\.1 200/);
    const overLimit = await raw(fixture.port, `GET /health HTTP/1.1\r\nHost: x\r\n${headers(64)}\r\n`);
    expect(overLimit).toMatch(/^HTTP\/1\.1 413/);
    expect(overLimit).toMatch(/Cache-Control: no-store/i);
    expect(overLimit).toMatch(/Connection: close/i);
  } finally { await fixture.server.shutdown(); }
});

it('rejects forbidden protocol and content headers before admission', async () => {
  const fixture = await gateway();
  try {
    for (const header of ['Trailer: Digest\r\n', 'Upgrade: websocket\r\n', 'Connection: accept\r\n']) {
      const response = await raw(fixture.port, inferenceWire(header, 'Content-Length: 2\r\n', '{}'));
      expect(response).toMatch(/^HTTP\/1\.1 400/);
      expect(response).toMatch(/Connection: close/i);
    }
    for (const contentType of [undefined, 'text/json', 'application/json; boundary=x', 'application/json; charset=utf-16']) {
      const header = contentType === undefined ? '' : `Content-Type: ${contentType}\r\n`;
      const response = await raw(fixture.port, inferenceWire(header, 'Content-Length: 2\r\n', '{}', false));
      expect(response).toMatch(/^HTTP\/1\.1 400/);
      expect(response).toMatch(/Connection: close/i);
    }
    expect(fixture.admissions()).toBe(0);
    expect(fixture.upstreamRequests()).toBe(0);
  } finally { await fixture.server.shutdown(); }
});

it('enforces inference JSON boundaries after provisional admission, including truncated and streamed bodies', async () => {
  const body = JSON.stringify({ model: catalogIds[0] });
  const limit = Buffer.byteLength(body) + 1;
  const fixture = await gateway({ inferenceBodyBytes: limit });
  try {
    const accepted = await raw(fixture.port, inferenceWire('', `Content-Length: ${Buffer.byteLength(body)}\r\n`, body));
    expect(accepted === '' || /^HTTP\/1\.1 502/.test(accepted)).toBe(true);
    expect(fixture.admissions()).toBe(1);

    const over = `${body}  `;
    const rejected = await raw(fixture.port, inferenceWire('', `Content-Length: ${Buffer.byteLength(over)}\r\n`, over));
    expect(rejected).toMatch(/^HTTP\/1\.1 413/);
    expect(rejected).toMatch(/Connection: close/i);

    const shortDeclared = await raw(fixture.port, inferenceWire('', `Content-Length: ${Buffer.byteLength(body) - 1}\r\n`, body));
    expect(shortDeclared).toMatch(/^HTTP\/1\.1 400/);

    const truncated = await raw(fixture.port, inferenceWire('', `Content-Length: ${Buffer.byteLength(body)}\r\n`, body.slice(0, -2)));
    expect(truncated === '' || /^HTTP\/1\.1 400/.test(truncated)).toBe(true);

    const streamed = await raw(fixture.port, inferenceWire('Transfer-Encoding: chunked\r\n', '', `${body.length.toString(16)}\r\n${body}\r\n2\r\n  \r\n0\r\n\r\n`));
    expect(streamed).toMatch(/^HTTP\/1\.1 400/);
    expect(fixture.admissions()).toBe(4);
    expect(fixture.upstreamRequests()).toBe(1);
  } finally { await fixture.server.shutdown(); }
});

it('rejects an over-limit declared body immediately without waiting for its remainder', async () => {
  const fixture = await gateway({ inferenceBodyBytes: 64 });
  try {
    const response = await rawWithoutEnding(fixture.port, inferenceWire('', 'Content-Length: 65\r\n', '{'));
    expect(response).toMatch(/^HTTP\/1\.1 413/);
    expect(response).toMatch(/Connection: close/i);
    expect(fixture.admissions()).toBe(1);
    expect(fixture.upstreamRequests()).toBe(0);
  } finally { await fixture.server.shutdown(); }
});

it('enforces control JSON boundaries without submitting partial or streamed operations', async () => {
  const body = JSON.stringify({ idempotencyKey: '00000000-0000-4000-8000-000000000000', action: 'unload', onBusy: 'reject' });
  const limit = Buffer.byteLength(body) + 1;
  const fixture = await gateway({ controlBodyBytes: limit });
  try {
    const accepted = await raw(fixture.port, controlWire(`Content-Length: ${Buffer.byteLength(body)}\r\n`, body));
    expect(accepted).toMatch(/^HTTP\/1\.1 200/);
    expect(fixture.submissions()).toBe(1);

    const over = `${body}  `;
    const rejected = await raw(fixture.port, controlWire(`Content-Length: ${Buffer.byteLength(over)}\r\n`, over));
    expect(rejected).toMatch(/^HTTP\/1\.1 413/);
    expect(rejected).toMatch(/Connection: close/i);

    const truncated = await raw(fixture.port, controlWire(`Content-Length: ${Buffer.byteLength(body)}\r\n`, body.slice(0, -3)));
    expect(truncated === '' || /^HTTP\/1\.1 400/.test(truncated)).toBe(true);

    const streamed = await raw(fixture.port, controlWire('Transfer-Encoding: chunked\r\n', `${body.length.toString(16)}\r\n${body}\r\n2\r\n  \r\n0\r\n\r\n`));
    expect(streamed).toMatch(/^HTTP\/1\.1 400/);
    expect(fixture.submissions()).toBe(1);
    expect(fixture.upstreamRequests()).toBe(0);
  } finally { await fixture.server.shutdown(); }
});

it('rejects every ambiguous target before child admission', async () => {
  const fixture = await gateway();
  try {
    for (const target of ['/v1/%2fchat', '/v1/%5cchat', '/v1/%2e%2e/x', '/v1/%zz', '/v1//models', '/v1/models/', 'http://x/v1/models', '/v1/models?x=1', '/v1/models#x']) {
      const response = await raw(fixture.port, `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
      expect(response).toMatch(/^HTTP\/1\.1 400/);
    }
    expect(fixture.admissions()).toBe(0);
  } finally { await fixture.server.shutdown(); }
});

async function gateway(limits: Record<string, number> = {}) {
  let admitted = 0; let submitted = 0; let upstream = 0;
  const engine = {
    snapshot: () => ({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 }), operations: () => [],
    submit: async (operation: unknown) => { submitted += 1; return { kind: 'noop', operation: { id: 'one', status: 'COMPLETED', request: operation } }; },
    cancel: () => ({ kind: 'conflict', code: 'operation_not_found' }),
    admitInference: () => { admitted += 1; return { kind: 'admitted', lease: { id: String(admitted), model: catalogIds[0], aborted: false, bindAbort: () => undefined, abort: () => undefined, complete: () => undefined } }; },
    completeInference: () => undefined, shutdown: async () => undefined,
  };
  const childRequest = ((..._args: unknown[]) => { upstream += 1; return request('http://127.0.0.1:1'); }) as never;
  const server = createManagerServer({ inferenceKey, managementKey, childEndpoint: 'http://127.0.0.1:18080', catalogIds, limits }, engine as never, { childRequest });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: (server.address() as import('node:net').AddressInfo).port, admissions: () => admitted, submissions: () => submitted, upstreamRequests: () => upstream };
}

function inferenceWire(extraHeaders: string, framing: string, body: string, includeContentType = true): string {
  return `POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${inferenceKey}\r\n${includeContentType ? 'Content-Type: application/json\r\n' : ''}${extraHeaders}${framing}\r\n${body}`;
}
function controlWire(framing: string, body: string): string {
  return `POST /gpu/v1/operations HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${managementKey}\r\nContent-Type: application/json\r\n${framing}\r\n${body}`;
}
function raw(port: number, wire: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }); let output = '';
    socket.setEncoding('utf8'); socket.setTimeout(1_000, () => socket.destroy(new Error('raw_timeout')));
    socket.on('connect', () => socket.end(wire)); socket.on('data', (chunk) => { output += chunk; });
    socket.on('end', () => resolve(output)); socket.on('close', () => resolve(output)); socket.on('error', (error) => output.length > 0 ? resolve(output) : reject(error));
  });
}
function rawWithoutEnding(port: number, wire: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }); let output = '';
    socket.setEncoding('utf8'); socket.setTimeout(500, () => socket.destroy(new Error('server_waited_for_body')));
    socket.on('connect', () => socket.write(wire)); socket.on('data', (chunk) => { output += chunk; });
    socket.on('end', () => resolve(output)); socket.on('close', () => output.length > 0 ? resolve(output) : reject(new Error('closed_without_response'))); socket.on('error', reject);
  });
}
