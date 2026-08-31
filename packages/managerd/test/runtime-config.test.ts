import { expect, it } from 'vitest';
import {
  parseProductionCatalog,
  parseProductionManagerConfig,
  type ProductionCatalogConfig,
  type ProductionManagerConfig,
} from '../src/runtime-config.js';

const catalog: ProductionCatalogConfig = {
  version: 1,
  binary: { path: '/opt/llama/bin/llama-server', bytes: 61_287_200, sha256: 'a'.repeat(64) },
  models: [
    { id: 'qwen3.8-27b', path: '/models/base-q5.gguf', bytes: 19_834_055_648, sha256: '1'.repeat(64), contextSize: 65_536, mtp: 2 },
    { id: 'qwen3.8-27b-uncensored', path: '/models/uncensored-q5.gguf', bytes: 19_535_701_408, sha256: '2'.repeat(64), contextSize: 65_536, mtp: 2 },
    { id: 'qwen3.8-27b-q4', path: '/models/base-q4.gguf', bytes: 17_106_775_008, sha256: '3'.repeat(64), contextSize: 131_072, mtp: 5 },
    { id: 'qwen3.8-27b-uncensored-q4', path: '/models/uncensored-q4.gguf', bytes: 16_810_714_528, sha256: '4'.repeat(64), contextSize: 131_072, mtp: 2 },
  ],
};

const manager: ProductionManagerConfig = {
  version: 1,
  startup: { mode: 'manual', initialState: 'UNLOADED', autoLoad: false, restoreLastModel: false },
  listen: { host: '0.0.0.0', port: 8080, addressFamily: 'ipv4' },
  networkPolicy: { trustedIpv4Cidrs: ['192.168.3.0/24'], enforcement: ['ufw', 'preflight'], ipv6: false },
  child: {
    host: '127.0.0.1', port: 18080, approvedDevice: 'Vulkan0',
    deviceMatcher: '^Vulkan0: AMD Radeon RX 7900 XTX \\(RADV NAVI31\\)$',
    parallel: 1, gpuLayers: 'all', flashAttention: true, kvCache: 'q8_0',
  },
  catalogPath: '/etc/qwen38-workload-manager/models.production.json',
  artifactIntegrity: { mode: 'strict', trustedOwnerUids: [0, 1001], maximumGroupWritableExceptionTtlMs: 86_400_000 },
  credentials: {
    inference: { systemdName: 'inference.key', sourcePath: '/etc/qwen38-workload-manager/credentials/inference.key', requiredMode: '0600' },
    management: { systemdName: 'management.key', sourcePath: '/etc/qwen38-workload-manager/credentials/management.key', requiredMode: '0600' },
  },
  paths: {
    runtimeDirectory: '/run/qwen38-workload-manager', stateDirectory: '/var/lib/qwen38-workload-manager',
    cacheDirectory: '/var/cache/qwen38-workload-manager', logDirectory: '/var/log/qwen38-workload-manager',
  },
};

it('accepts and deeply freezes only the reviewed manual production contract', () => {
  const parsedManager = parseProductionManagerConfig(manager);
  const parsedCatalog = parseProductionCatalog(catalog);
  expect(parsedManager.startup).toEqual({ mode: 'manual', initialState: 'UNLOADED', autoLoad: false, restoreLastModel: false });
  expect(parsedManager.networkPolicy).toEqual({ trustedIpv4Cidrs: ['192.168.3.0/24'], enforcement: ['ufw', 'preflight'], ipv6: false });
  expect(parsedCatalog.models.map((model) => [model.id, model.contextSize, model.mtp])).toEqual([
    ['qwen3.8-27b', 65_536, 2],
    ['qwen3.8-27b-uncensored', 65_536, 2],
    ['qwen3.8-27b-q4', 131_072, 5],
    ['qwen3.8-27b-uncensored-q4', 131_072, 2],
  ]);
  expect(Object.isFrozen(parsedManager.credentials)).toBe(true);
  expect(Object.isFrozen(parsedCatalog.models[0])).toBe(true);
});

it.each([
  ['automatic startup', { ...manager, startup: { ...manager.startup, autoLoad: true } }],
  ['last-model restore', { ...manager, startup: { ...manager.startup, restoreLastModel: true } }],
  ['IPv6 wildcard', { ...manager, networkPolicy: { ...manager.networkPolicy, ipv6: true } }],
  ['broader LAN', { ...manager, networkPolicy: { ...manager.networkPolicy, trustedIpv4Cidrs: ['0.0.0.0/0'] } }],
  ['non-loopback child', { ...manager, child: { ...manager.child, host: '0.0.0.0' } }],
  ['unknown key', { ...manager, automaticModel: 'qwen3.8-27b' }],
])('rejects %s', (_label, value) => {
  expect(() => parseProductionManagerConfig(value)).toThrow(/invalid_production_manager_config/);
});

it.each([
  ['unknown model', { ...catalog, models: [...catalog.models.slice(0, 3), { ...catalog.models[3]!, id: 'attacker' }] }],
  ['relative model path', { ...catalog, models: [{ ...catalog.models[0]!, path: '../model.gguf' }, ...catalog.models.slice(1) ] }],
  ['bad digest', { ...catalog, binary: { ...catalog.binary, sha256: 'A'.repeat(64) } }],
  ['extra argv field', { ...catalog, binary: { ...catalog.binary, args: ['--listen', '0.0.0.0'] } }],
])('rejects catalog %s', (_label, value) => {
  expect(() => parseProductionCatalog(value)).toThrow(/invalid_production_catalog/);
});
