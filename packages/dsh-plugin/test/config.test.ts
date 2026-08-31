import { describe, expect, it } from 'vitest';
import { parsePluginConfig } from '../src/config.js';

describe('parsePluginConfig', () => {
  it('materializes the Ubuntu loopback endpoint without storing a secret value', () => {
    expect(parsePluginConfig({ role: 'server', managementCredentialRef: 'GPU_MANAGER_KEY' })).toEqual({
      role: 'server',
      managerUrl: 'http://127.0.0.1:8080',
      managementCredentialRef: 'GPU_MANAGER_KEY',
    });
  });

  it('accepts an explicitly configured private-LAN endpoint for the Mac role', () => {
    expect(parsePluginConfig({
      role: 'client',
      managerUrl: 'http://192.168.50.10:8080',
      managementCredentialRef: 'GPU_MANAGER_KEY',
    })).toEqual({
      role: 'client',
      managerUrl: 'http://192.168.50.10:8080',
      managementCredentialRef: 'GPU_MANAGER_KEY',
    });
  });

  it.each([
    [{ managementCredentialRef: 'GPU_MANAGER_KEY' }, 'invalid_plugin_config'],
    [{ role: 'server', managementCredentialRef: 'GPU_MANAGER_KEY', unexpected: true }, 'invalid_plugin_config'],
    [{ role: 'server', managerUrl: 'http://192.168.50.10:8080', managementCredentialRef: 'GPU_MANAGER_KEY' }, 'invalid_manager_url'],
    [{ role: 'client', managerUrl: 'http://8.8.8.8:8080', managementCredentialRef: 'GPU_MANAGER_KEY' }, 'invalid_manager_url'],
    [{ role: 'client', managerUrl: 'https://192.168.50.10:8080', managementCredentialRef: 'GPU_MANAGER_KEY' }, 'invalid_manager_url'],
    [{ role: 'client', managerUrl: 'http://user:pass@192.168.50.10:8080', managementCredentialRef: 'GPU_MANAGER_KEY' }, 'invalid_manager_url'],
    [{ role: 'client', managerUrl: 'http://192.168.50.10:8080/gpu/v1', managementCredentialRef: 'GPU_MANAGER_KEY' }, 'invalid_manager_url'],
    [{ role: 'client', managerUrl: 'http://192.168.50.10:8080', managementCredentialRef: 'not-a-ref' }, 'invalid_credential_reference'],
  ] as const)('rejects unsafe or ambiguous configuration %#', (value, code) => {
    expect(() => parsePluginConfig(value)).toThrow(code);
  });
});
