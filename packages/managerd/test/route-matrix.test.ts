import { once } from 'node:events';
import { request } from 'node:http';
import { expect, it } from 'vitest';
import { createManagerServer } from '../src/server.js';

const inferenceKey = 'a'.repeat(64); const managementKey = 'b'.repeat(64);
const model = 'qwen3.8-27b';
const catalogIds = [model, 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4'];
const operationId = '11111111-1111-4111-8111-111111111111';
const operation = { id: operationId, status: 'QUEUED', request: { idempotencyKey: operationId, action: 'unload', onBusy: 'queue' }, createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z' };

interface RouteCase {
  readonly path: string;
  readonly method: string;
  readonly wrongMethod: string;
  readonly allow: string;
  readonly realm: 'public' | 'inference' | 'management';
  readonly expected: number;
  readonly body?: string;
  readonly inference?: boolean;
}

const routes: readonly RouteCase[] = [
  { path: '/health', method: 'GET', wrongMethod: 'POST', allow: 'GET', realm: 'public', expected: 200 },
  { path: '/metrics', method: 'GET', wrongMethod: 'POST', allow: 'GET', realm: 'management', expected: 200 },
  { path: '/v1/models', method: 'GET', wrongMethod: 'POST', allow: 'GET', realm: 'inference', expected: 200 },
  ...['/v1/chat/completions', '/v1/completions', '/v1/responses'].map((path): RouteCase => ({ path, method: 'POST', wrongMethod: 'GET', allow: 'POST', realm: 'inference', expected: 409, body: JSON.stringify({ model }), inference: true })),
  { path: '/gpu/v1/status', method: 'GET', wrongMethod: 'POST', allow: 'GET', realm: 'management', expected: 200 },
  { path: '/gpu/v1/models', method: 'GET', wrongMethod: 'POST', allow: 'GET', realm: 'management', expected: 200 },
  { path: '/gpu/v1/operations', method: 'POST', wrongMethod: 'GET', allow: 'POST', realm: 'management', expected: 200, body: JSON.stringify({ idempotencyKey: operationId, action: 'unload', onBusy: 'reject' }) },
  { path: `/gpu/v1/operations/${operationId}`, method: 'GET', wrongMethod: 'POST', allow: 'GET, DELETE', realm: 'management', expected: 200 },
  { path: `/gpu/v1/operations/${operationId}`, method: 'DELETE', wrongMethod: 'PATCH', allow: 'GET, DELETE', realm: 'management', expected: 200 },
];

it('enforces the complete route, method, realm, and Allow matrix', async () => {
  let admissions = 0; let upstreamRequests = 0;
  const engine = {
    snapshot: () => ({ phase: 'READY', activeModel: model, activeRequestCount: 0 }), operations: () => [operation],
    submit: async () => ({ kind: 'noop', operation }), cancel: () => ({ kind: 'cancelled', operation: { ...operation, status: 'CANCELLED' } }),
    admitInference: () => { admissions += 1; return { kind: 'rejected', code: 'model_transition' }; }, completeInference: () => undefined, shutdown: async () => undefined,
  };
  const childRequest = (() => { upstreamRequests += 1; return request('http://127.0.0.1:1'); }) as never;
  const server = createManagerServer({ inferenceKey, managementKey, childEndpoint: 'http://127.0.0.1:18080', catalogIds }, engine as never, { childRequest });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    for (const route of routes) {
      const admittedBefore = admissions;
      const wrongMethod = await call(server, route.path, route.wrongMethod, credentialFor(route.realm), route.wrongMethod === 'POST' ? route.body : undefined);
      expect(wrongMethod.status, `${route.path} wrong method`).toBe(405);
      expect(wrongMethod.headers.allow, `${route.path} Allow`).toBe(route.allow);
      if (route.inference) { expect(admissions).toBe(admittedBefore); expect(upstreamRequests).toBe(0); }

      if (route.realm === 'public') {
        for (const credential of [undefined, inferenceKey, managementKey]) expect((await call(server, route.path, route.method, credential, route.body)).status).toBe(route.expected);
        continue;
      }

      for (const credential of [undefined, wrongCredentialFor(route.realm)]) {
        const rejectedBefore = admissions;
        const rejected = await call(server, route.path, route.method, credential, route.body);
        expect(rejected.status, `${route.path} rejected realm`).toBe(401);
        expect(rejected.headers['cache-control']).toBe('no-store');
        if (route.inference) { expect(admissions).toBe(rejectedBefore); expect(upstreamRequests).toBe(0); }
      }
      expect((await call(server, route.path, route.method, credentialFor(route.realm), route.body)).status, `${route.path} accepted realm`).toBe(route.expected);
    }
    expect(upstreamRequests).toBe(0);
    expect(admissions).toBe(3);
  } finally { await server.shutdown(); }
});

function credentialFor(realm: RouteCase['realm']): string | undefined { return realm === 'inference' ? inferenceKey : realm === 'management' ? managementKey : undefined; }
function wrongCredentialFor(realm: Exclude<RouteCase['realm'], 'public'>): string { return realm === 'inference' ? managementKey : inferenceKey; }

function call(server: import('node:http').Server, path: string, method: string, credential?: string, body?: string): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port, path, method, headers: { ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }), ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) } }, (response) => {
      response.resume(); response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
    });
    client.on('error', reject); client.end(body);
  });
}
