import { request } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createManagerServer } from '../src/server.js';

const inferenceKey = 'a'.repeat(64);
const managementKey = 'b'.repeat(64);
const catalogIds = ['qwen3.8-27b', 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4'];

it('keeps inference and management credentials separate', async () => {
  const server = createManagerServer({ inferenceKey, managementKey, catalogIds: ['qwen3.8-27b', 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4'], childEndpoint: 'http://127.0.0.1:18080' }, fakeEngine() as never);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await get(server, '/gpu/v1/status', managementKey)).status).toBe(200);
    expect((await get(server, '/v1/models', inferenceKey)).status).toBe(200);
    expect((await get(server, '/gpu/v1/status', inferenceKey)).status).toBe(401);
    expect((await get(server, '/v1/models', managementKey)).status).toBe(401);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it('accepts only case-insensitive Bearer schemes with one exact credential', async () => {
  const server = createManagerServer({ inferenceKey, managementKey, catalogIds: ['qwen3.8-27b', 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4'], childEndpoint: 'http://127.0.0.1:18080' }, fakeEngine() as never);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { expect((await rawGet(server, `bEaReR ${inferenceKey}`)).status).toBe(200); } finally { await server.shutdown(); }
});

it('generically rejects comma-joined, malformed, short, and wrong bearer values', async () => {
  const server = createManagerServer({ inferenceKey, managementKey, catalogIds: ['qwen3.8-27b', 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4'], childEndpoint: 'http://127.0.0.1:18080' }, fakeEngine() as never);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    for (const authorization of [
      `Bearer ${inferenceKey}, Bearer ${inferenceKey}`,
      `Basic ${inferenceKey}`,
      `Bearer  ${inferenceKey}`,
      `Bearer ${'a'.repeat(63)}`,
      `Bearer ${'g'.repeat(64)}`,
      `Bearer ${managementKey}`,
      '',
    ]) {
      const result = await rawGet(server, authorization);
      expect(result.status).toBe(401);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.headers['www-authenticate']).toBe('Bearer');
      expect(result.text).toBe('{"error":{"code":"unauthorized"}}');
      if (authorization.length > 0) expect(result.text).not.toContain(authorization);
    }
  } finally { await server.shutdown(); }
});

it('keeps metrics management-only and exposes only the fixed catalog labels', async () => {
  const server = createManagerServer({ inferenceKey, managementKey, catalogIds, childEndpoint: 'http://127.0.0.1:18080' }, fakeEngine() as never);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect((await metricsGet(server)).status).toBe(401);
    expect((await metricsGet(server, inferenceKey)).status).toBe(401);
    const accepted = await metricsGet(server, managementKey);
    expect(accepted.status).toBe(200);
    expect(accepted.text).toContain('manager_inference_ttft_seconds_count{model="qwen3.8-27b"} 0\n');
    expect(accepted.text).not.toContain(inferenceKey);
    expect(accepted.text).not.toContain(managementKey);
  } finally { await server.shutdown(); }
});

function fakeEngine() {
  return { snapshot: () => ({ phase: 'UNLOADED', activeRequestCount: 0 }), operations: () => [], submit: async () => { throw new Error('not_called'); }, cancel: () => ({ kind: 'conflict', code: 'operation_not_found' }), admitInference: () => ({ kind: 'rejected', code: 'model_transition' }), completeInference: () => undefined, shutdown: async () => undefined };
}
function get(server: import('node:http').Server, path: string, key: string): Promise<{ status: number }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port, path, headers: { authorization: `Bearer ${key}` } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 })); }); req.on('error', reject); req.end(); });
}
function rawGet(server: import('node:http').Server, authorization: string): Promise<{ status: number; text: string; headers: import('node:http').IncomingHttpHeaders }> { const port = (server.address() as import('node:net').AddressInfo).port; return new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port, path: '/v1/models', headers: { authorization } }, (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers })); }); req.on('error', reject); req.end(); }); }
function metricsGet(server: import('node:http').Server, key?: string): Promise<{ status: number; text: string }> { const port = (server.address() as import('node:net').AddressInfo).port; return new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port, path: '/metrics', headers: key === undefined ? {} : { authorization: `Bearer ${key}` } }, (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text })); }); req.on('error', reject); req.end(); }); }
