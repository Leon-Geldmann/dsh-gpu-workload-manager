import { once } from 'node:events';
import { request } from 'node:http';
import { expect, it } from 'vitest';
import { FIXED_CATALOG_IDS } from '../src/config.js';
import { createManagerServer } from '../src/server.js';

const inferenceKey = 'a'.repeat(64); const managementKey = 'b'.repeat(64);

it('maps the fixed four-model directory for READY, transition, and UNLOADED snapshots', async () => {
  const cases = [
    { snapshot: { phase: 'READY', activeModel: FIXED_CATALOG_IDS[2], activeRequestCount: 0 }, expected: ['unloaded', 'unloaded', 'loaded', 'unloaded'] },
    { snapshot: { phase: 'STARTING', activeModel: FIXED_CATALOG_IDS[0], target: FIXED_CATALOG_IDS[1], activeRequestCount: 0 }, expected: ['unloaded', 'loading', 'unloaded', 'unloaded'] },
    { snapshot: { phase: 'UNLOADED', activeRequestCount: 0 }, expected: ['unloaded', 'unloaded', 'unloaded', 'unloaded'] },
  ] as const;
  for (const entry of cases) {
    const engine = fakeEngine(entry.snapshot); const server = createManagerServer({ inferenceKey, managementKey, childEndpoint: 'http://127.0.0.1:18080' }, engine as never);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const response = await getModels(server);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ object: 'list', data: FIXED_CATALOG_IDS.map((id, index) => ({ id, object: 'model', status: { value: entry.expected[index] } })) });
    } finally { await server.shutdown(); }
  }
});

function fakeEngine(snapshot: object) {
  return { snapshot: () => snapshot, operations: () => [], submit: async () => { throw new Error('not_called'); }, cancel: () => ({ kind: 'conflict', code: 'operation_not_found' }), admitInference: () => ({ kind: 'rejected', code: 'model_transition' }), completeInference: () => undefined, shutdown: async () => undefined };
}
function getModels(server: import('node:http').Server): Promise<{ status: number; body: unknown }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port, path: '/v1/models', headers: { authorization: `Bearer ${inferenceKey}` } }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
    }); client.on('error', reject); client.end();
  });
}
