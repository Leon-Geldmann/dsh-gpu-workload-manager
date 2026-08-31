import { once } from 'node:events';
import { createConnection } from 'node:net';
import { expect, it } from 'vitest';
import { createManagerServer } from '../src/server.js';

const inferenceKey = 'a'.repeat(64); const managementKey = 'b'.repeat(64);
const catalogIds = ['qwen3.8-27b', 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4'];

it('closes a slow partial header within the configured headers timeout', async () => {
  const fixture = await gateway({ headersTimeoutMs: 20, requestTimeoutMs: 80 });
  try {
    await expect(serverCloses(fixture.port, 'GET /health HTTP/1.1\r\nHost:')).resolves.toBeDefined();
    expect(fixture.admissions()).toBe(0);
    expect(fixture.completions()).toBe(0);
  } finally { await fixture.server.shutdown(); }
});

it('closes a slow partial JSON body within the configured request timeout', async () => {
  const fixture = await gateway({ headersTimeoutMs: 20, requestTimeoutMs: 40 });
  try {
    const prefix = `POST /v1/responses HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${inferenceKey}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`;
    await expect(serverCloses(fixture.port, prefix)).resolves.toBeDefined();
    expect(fixture.admissions()).toBe(1);
    await waitFor(() => fixture.completions() === 1);
    expect(fixture.completions()).toBe(1);
  } finally { await fixture.server.shutdown(); }
});

async function gateway(limits: Record<string, number>) {
  let admissions = 0; let completions = 0;
  const engine = {
    snapshot: () => ({ phase: 'READY', activeModel: catalogIds[0], activeRequestCount: 0 }), operations: () => [], submit: async () => { throw new Error('not_called'); }, cancel: () => ({ kind: 'conflict', code: 'operation_not_found' }),
    admitInference: () => { admissions += 1; return { kind: 'admitted', lease: { id: String(admissions), model: catalogIds[0], aborted: false, bindAbort: () => undefined, abort: () => undefined, complete: () => { completions += 1; } } }; }, completeInference: () => undefined, shutdown: async () => undefined,
  };
  const server = createManagerServer({ inferenceKey, managementKey, childEndpoint: 'http://127.0.0.1:18080', catalogIds, limits }, engine as never);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: (server.address() as import('node:net').AddressInfo).port, admissions: () => admissions, completions: () => completions };
}

function serverCloses(port: number, prefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }); let output = ''; let settled = false;
    const watchdog = setTimeout(() => { if (!settled) { settled = true; socket.destroy(); reject(new Error('server_did_not_enforce_timeout')); } }, 750); watchdog.unref();
    socket.setEncoding('utf8'); socket.on('connect', () => socket.write(prefix)); socket.on('data', (chunk) => { output += chunk; });
    socket.on('error', (error: NodeJS.ErrnoException) => { if (!settled && error.code !== 'ECONNRESET') { settled = true; clearTimeout(watchdog); reject(error); } });
    socket.on('close', () => { if (!settled) { settled = true; clearTimeout(watchdog); resolve(output); } });
  });
}
function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => { const deadline = Date.now() + 500; const poll = () => { if (predicate()) return resolve(); if (Date.now() >= deadline) return reject(new Error('condition_timeout')); setTimeout(poll, 5).unref(); }; poll(); });
}
