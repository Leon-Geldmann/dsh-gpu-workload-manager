import { expect, it } from 'vitest';
import { parseManagerServerConfig } from '../src/config.js';
import { isTrustedManagerPeer } from '../src/server.js';

const keys = { inferenceKey: 'a'.repeat(64), managementKey: 'b'.repeat(64) };

it('accepts only loopback and the configured 192.168.3.0/24 LAN', () => {
  for (const address of ['127.0.0.1', '::1', '192.168.3.1', '192.168.3.254', '::ffff:192.168.3.200']) {
    expect(isTrustedManagerPeer(address, '192.168.3.0/24'), address).toBe(true);
  }
  for (const address of [undefined, '0.0.0.0', '192.168.2.99', '192.168.4.1', '10.0.0.2', '203.0.113.8', 'fe80::1']) {
    expect(isTrustedManagerPeer(address, '192.168.3.0/24'), String(address)).toBe(false);
  }
});

it('pins the manager server to the one reviewed LAN boundary', () => {
  expect(parseManagerServerConfig({ ...keys, childEndpoint: 'http://127.0.0.1:18080' }).trustedLanCidr).toBe('192.168.3.0/24');
  expect(() => parseManagerServerConfig({ ...keys, childEndpoint: 'http://127.0.0.1:18080', trustedLanCidr: '0.0.0.0/0' })).toThrow(/invalid_manager_server_config/);
  expect(() => parseManagerServerConfig({ ...keys, childEndpoint: 'http://127.0.0.1:18080', trustedLanCidr: '192.168.0.0\/16' })).toThrow(/invalid_manager_server_config/);
});
