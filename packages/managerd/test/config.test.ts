import { expect, it } from 'vitest';
import { parseManagerServerConfig, parseSupervisorConfig } from '../src/config.js';

it('rejects non-loopback child listener and unapproved device policy', () => {
  expect(() => parseSupervisorConfig({ binary: '/pinned/llama-server', host: '0.0.0.0', port: 18080, approvedDevice: 'Vulkan0' })).toThrow(/invalid_supervisor_config/);
  expect(() => parseSupervisorConfig({ binary: '/pinned/llama-server', host: '127.0.0.1', port: 18080, approvedDevice: '' })).toThrow(/invalid_supervisor_config/);
});

it('accepts only the fixed child endpoint and four-model gateway catalog', () => {
  const keys = { inferenceKey: 'a'.repeat(64), managementKey: 'b'.repeat(64) };
  expect(() => parseManagerServerConfig({ ...keys, childEndpoint: 'http://127.0.0.1:18080/admin' })).toThrow(/invalid_child_endpoint/);
  expect(() => parseManagerServerConfig({ ...keys, childEndpoint: 'http://127.0.0.1:18080', catalogIds: ['a', 'b', 'c', 'd'] })).toThrow(/invalid_manager_server_config/);
  expect(() => parseManagerServerConfig({ ...keys, childEndpoint: 'http://127.0.0.1:18080', unexpected: true })).toThrow(/invalid_manager_server_config/);
});
