import { once } from 'node:events';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createManagerServer } from '../src/server.js';

const keys = { inferenceKey: 'a'.repeat(64), managementKey: 'b'.repeat(64), childEndpoint: 'http://127.0.0.1:18080' };
const catalogIds = ['qwen3.8-27b', 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4'];

it('requires management auth and parses a whitelisted operation before submitting it', async () => {
  const calls: unknown[] = [];
  const engine = { snapshot: () => ({ phase: 'UNLOADED', activeRequestCount: 0 }), operations: () => [], submit: async (value: unknown) => { calls.push(value); return { kind: 'noop' as const, operation: { id: '1', status: 'COMPLETED', request: value } }; }, cancel: () => ({ kind: 'conflict' as const, code: 'operation_not_found' as const }), admitInference: () => ({ kind: 'rejected' as const, code: 'model_transition' as const }), completeInference: () => undefined, shutdown: async () => undefined };
  const server = createManagerServer({ ...keys, catalogIds }, engine as never); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const payload = JSON.stringify({ idempotencyKey: randomUUID(), action: 'unload', onBusy: 'reject', unexpected: true });
    expect((await call(server, '/gpu/v1/operations', 'POST', keys.managementKey, payload)).status).toBe(400);
    expect(calls).toEqual([]);
    const valid = JSON.stringify({ idempotencyKey: randomUUID(), action: 'unload', onBusy: 'reject' });
    expect((await call(server, '/gpu/v1/operations', 'POST', keys.managementKey, valid)).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await call(server, '/gpu/v1/status', 'GET', keys.inferenceKey)).status).toBe(401);
  } finally { await server.shutdown(); }
});

it('returns complete status, models, operation lookup, and cancellation structures', async () => {
  const operationId = '11111111-1111-4111-8111-111111111111';
  const missingId = '22222222-2222-4222-8222-222222222222';
  const operation = { id: operationId, status: 'QUEUED', request: { idempotencyKey: operationId, action: 'switch', model: catalogIds[2], onBusy: 'queue' }, createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:01.000Z' };
  const cancelled = { ...operation, status: 'CANCELLED', updatedAt: '2026-08-29T00:00:02.000Z' };
  const snapshot = { phase: 'DRAINING', activeModel: catalogIds[0], activeRequestCount: 1, target: catalogIds[2], activeOperation: operation };
  const engine = {
    snapshot: () => snapshot, operations: () => [operation], submit: async () => { throw new Error('not_called'); },
    cancel: (id: string) => id === operationId ? { kind: 'cancelled', operation: cancelled } : { kind: 'conflict', code: 'operation_not_found' },
    admitInference: () => ({ kind: 'rejected', code: 'model_transition' }), completeInference: () => undefined, shutdown: async () => undefined,
  };
  const server = createManagerServer({ ...keys, catalogIds }, engine as never); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    expect(body(await call(server, '/gpu/v1/status', 'GET', keys.managementKey))).toEqual(snapshot);
    expect(body(await call(server, '/gpu/v1/models', 'GET', keys.managementKey))).toEqual({
      object: 'list', data: catalogIds.map((id) => ({ id, object: 'model', status: { value: id === catalogIds[2] ? 'loading' : 'unloaded' } })),
    });
    expect(body(await call(server, `/gpu/v1/operations/${operationId}`, 'GET', keys.managementKey))).toEqual({ operation });
    const missing = await call(server, `/gpu/v1/operations/${missingId}`, 'GET', keys.managementKey);
    expect(missing.status).toBe(404); expect(body(missing)).toEqual({ error: { code: 'operation_not_found' } });
    expect(body(await call(server, `/gpu/v1/operations/${operationId}`, 'DELETE', keys.managementKey))).toEqual({ operation: cancelled });
    const conflict = await call(server, `/gpu/v1/operations/${missingId}`, 'DELETE', keys.managementKey);
    expect(conflict.status).toBe(409); expect(body(conflict)).toEqual({ error: { code: 'operation_not_found' } });
    for (const path of ['/gpu/v1/status', '/gpu/v1/models', `/gpu/v1/operations/${operationId}`]) expect((await call(server, path, 'GET', keys.inferenceKey)).status).toBe(401);
  } finally { await server.shutdown(); }
});

it('returns service unavailable when a control body completes after shutdown linearizes', async () => {
  const engine = {
    snapshot: () => ({ phase: 'STOPPING', activeRequestCount: 0 }), operations: () => [],
    submit: async () => ({ kind: 'unavailable', code: 'manager_shutting_down' }),
    cancel: () => ({ kind: 'conflict', code: 'operation_not_found' }),
    admitInference: () => ({ kind: 'rejected', code: 'model_transition' }), completeInference: () => undefined,
    shutdown: async () => undefined,
  };
  const server = createManagerServer({ ...keys, catalogIds }, engine as never); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const payload = JSON.stringify({ idempotencyKey: randomUUID(), action: 'unload', onBusy: 'reject' });
    const result = await call(server, '/gpu/v1/operations', 'POST', keys.managementKey, payload);
    expect(result.status).toBe(503);
    expect(body(result)).toEqual({ error: { code: 'manager_shutting_down' } });
  } finally { await server.shutdown(); }
});

function body(result: { text: string }): unknown { return JSON.parse(result.text); }

function call(server: import('node:http').Server, path: string, method: string, key: string, body?: string): Promise<{ status: number; text: string }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port, path, method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) } }, (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text })); }); req.on('error', reject); req.end(body); });
}
