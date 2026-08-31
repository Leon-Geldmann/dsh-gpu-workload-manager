import { once } from 'node:events';
import { createConnection } from 'node:net';
import { expect, it } from 'vitest';
import { createManagerServer } from '../src/server.js';

const inferenceKey = 'a'.repeat(64); const managementKey = 'b'.repeat(64);
const catalogIds = ['qwen3.8-27b', 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4'];

it('cleans every accepted socket in finally when engine shutdown fails', async () => {
  let shutdownCalls = 0;
  const engine = {
    snapshot: () => ({ phase: 'UNLOADED', activeRequestCount: 0 }), operations: () => [],
    submit: async () => { throw new Error('not_called'); }, cancel: () => ({ kind: 'conflict', code: 'operation_not_found' }),
    admitInference: () => ({ kind: 'rejected', code: 'model_transition' }), completeInference: () => undefined,
    shutdown: async () => { shutdownCalls += 1; throw new Error('supervisor_stop_failed'); },
  };
  const server = createManagerServer({ inferenceKey, managementKey, childEndpoint: 'http://127.0.0.1:18080', catalogIds }, engine as never);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  const sockets = [createConnection({ host: '127.0.0.1', port }), createConnection({ host: '127.0.0.1', port })];
  await Promise.all(sockets.map((socket) => once(socket, 'connect')));
  const closed = sockets.map((socket) => new Promise<void>((resolve) => { socket.on('error', () => undefined); socket.once('close', () => resolve()); }));

  const first = server.shutdown(); const repeated = server.shutdown();
  expect(repeated).toBe(first);
  await expect(first).rejects.toThrow('supervisor_stop_failed');
  await Promise.all(closed);
  expect(shutdownCalls).toBe(1);
  expect(server.address()).toBeNull();
  expect(sockets.every((socket) => socket.destroyed)).toBe(true);
});
