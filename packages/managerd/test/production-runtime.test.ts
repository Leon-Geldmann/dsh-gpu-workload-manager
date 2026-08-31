import { expect, it, vi } from 'vitest';
import { closeSync, openSync } from 'node:fs';
import { once } from 'node:events';
import { request } from 'node:http';
import type { ArtifactExpectation, ArtifactPin } from '../src/file-integrity.js';
import { createArtifactGate, createProductionRuntime, parseRuntimeArguments } from '../src/production-runtime.js';
import { parseProductionCatalog, parseProductionManagerConfig, type ProductionCatalogConfig } from '../src/runtime-config.js';
import { Metrics } from '../src/metrics.js';

const source: ProductionCatalogConfig = {
  version: 1,
  binary: { path: '/opt/llama-server', bytes: 100, sha256: 'a'.repeat(64) },
  models: [
    { id: 'qwen3.8-27b', path: '/models/1.gguf', bytes: 101, sha256: '1'.repeat(64), contextSize: 65_536, mtp: 2 },
    { id: 'qwen3.8-27b-uncensored', path: '/models/2.gguf', bytes: 102, sha256: '2'.repeat(64), contextSize: 65_536, mtp: 2 },
    { id: 'qwen3.8-27b-q4', path: '/models/3.gguf', bytes: 103, sha256: '3'.repeat(64), contextSize: 131_072, mtp: 5 },
    { id: 'qwen3.8-27b-uncensored-q4', path: '/models/4.gguf', bytes: 104, sha256: '4'.repeat(64), contextSize: 131_072, mtp: 2 },
  ],
};

it('pins the binary and every model before serving, then revalidates the binary and requested model before spawn', async () => {
  const catalog = parseProductionCatalog(source);
  const pinned: string[] = [];
  const revalidated: string[] = [];
  const pinArtifact = vi.fn(async (expectation: ArtifactExpectation) => {
    pinned.push(expectation.path);
    return fakePin(expectation);
  });
  const revalidatePinnedArtifact = vi.fn(async (expectation: ArtifactExpectation, pin: ArtifactPin) => {
    revalidated.push(expectation.path);
    return pin;
  });

  const gate = await createArtifactGate(catalog, [0, 1001], { pinArtifact, revalidatePinnedArtifact });
  expect(pinned).toEqual(['/opt/llama-server', '/models/1.gguf', '/models/2.gguf', '/models/3.gguf', '/models/4.gguf']);
  await gate.validateArtifacts(catalog.models[2]!);
  expect(revalidated).toEqual(['/opt/llama-server', '/models/3.gguf']);
  expect(pinArtifact).toHaveBeenCalledTimes(5);
});

it('rejects caller-built model specs at the artifact gate', async () => {
  const catalog = parseProductionCatalog(source);
  const gate = await createArtifactGate(catalog, [0, 1001], {
    pinArtifact: async (expectation) => fakePin(expectation),
    revalidatePinnedArtifact: async (_expectation, pin) => pin,
  });
  await expect(gate.validateArtifacts({ ...catalog.models[0]!, path: '/attacker.gguf' })).rejects.toThrow(/model_not_in_production_catalog/);
});

it('accepts only the fixed systemd argv contract with systemd credentials present', () => {
  const directory = '/run/credentials/qwen38-workload-manager.service';
  expect(parseRuntimeArguments([
    '--manager-config', '/etc/qwen38-workload-manager/manager.production.json',
    '--models-config', '/etc/qwen38-workload-manager/models.production.json',
  ], { CREDENTIALS_DIRECTORY: directory })).toEqual({
    managerConfigPath: '/etc/qwen38-workload-manager/manager.production.json',
    modelsConfigPath: '/etc/qwen38-workload-manager/models.production.json',
  });

  expect(() => parseRuntimeArguments([
    '--manager-config', '/tmp/manager.json',
    '--models-config', '/etc/qwen38-workload-manager/models.production.json',
  ], { CREDENTIALS_DIRECTORY: directory })).toThrow(/invalid_runtime_arguments/);
});

it('constructs a genuinely unloaded runtime and closes its credential descriptor on shutdown', async () => {
  const catalog = parseProductionCatalog(source);
  const manager = parseProductionManagerConfig(productionManagerFixture());
  const inferenceFd = openSync('/dev/null', 'r');
  const close = vi.fn(() => closeSync(inferenceFd));
  const runtime = await createProductionRuntime(manager, catalog, {
    inferenceKey: 'a'.repeat(64), managementKey: 'b'.repeat(64), inferenceFd, close,
  }, {
    artifacts: {
      pinArtifact: async (expectation) => fakePin(expectation),
      revalidatePinnedArtifact: async (_expectation, pin) => pin,
    },
  });

  expect(runtime.snapshot()).toEqual({ phase: 'UNLOADED', activeRequestCount: 0 });
  await runtime.shutdown();
  await runtime.shutdown();
  expect(close).toHaveBeenCalledTimes(1);
});

it('serves the one production telemetry instance shared by server, engine, and supervisor', async () => {
  const catalog = parseProductionCatalog(source);
  const manager = parseProductionManagerConfig(productionManagerFixture());
  const inferenceFd = openSync('/dev/null', 'r');
  const metrics = new Metrics(catalog.models.map((model) => model.id));
  metrics.observeQueueWait(catalog.models[0]!.id, 2.5);
  const runtime = await createProductionRuntime(manager, catalog, {
    inferenceKey: 'a'.repeat(64), managementKey: 'b'.repeat(64), inferenceFd, close: () => closeSync(inferenceFd),
  }, {
    metrics,
    artifacts: {
      pinArtifact: async (expectation) => fakePin(expectation),
      revalidatePinnedArtifact: async (_expectation, pin) => pin,
    },
  });
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  try {
    const rendered = await getMetrics(runtime.server, 'b'.repeat(64));
    expect(rendered).toContain('manager_queue_wait_seconds_sum{model="qwen3.8-27b"} 2.5\n');
  } finally { await runtime.shutdown(); }
});

function fakePin(expectation: ArtifactExpectation): ArtifactPin {
  return Object.freeze({
    version: 1,
    ...expectation,
    file: Object.freeze({ path: expectation.path, dev: '1', inode: '1', uid: 0, gid: 0, mode: 0o100500, mtimeNs: '1', ctimeNs: '1', size: String(expectation.bytes) }),
    ancestors: Object.freeze([]),
  });
}

function productionManagerFixture(): unknown {
  return {
    version: 1,
    startup: { mode: 'manual', initialState: 'UNLOADED', autoLoad: false, restoreLastModel: false },
    listen: { host: '0.0.0.0', port: 8080, addressFamily: 'ipv4' },
    networkPolicy: { trustedIpv4Cidrs: ['192.168.3.0/24'], enforcement: ['ufw', 'preflight'], ipv6: false },
    child: { host: '127.0.0.1', port: 18080, approvedDevice: 'Vulkan0', deviceMatcher: '^Vulkan0: AMD Radeon RX 7900 XTX \\(RADV NAVI31\\)$', parallel: 1, gpuLayers: 'all', flashAttention: true, kvCache: 'q8_0' },
    catalogPath: '/etc/qwen38-workload-manager/models.production.json',
    artifactIntegrity: { mode: 'strict', trustedOwnerUids: [0, 1001], maximumGroupWritableExceptionTtlMs: 86_400_000 },
    credentials: {
      inference: { systemdName: 'inference.key', sourcePath: '/etc/qwen38-workload-manager/credentials/inference.key', requiredMode: '0600' },
      management: { systemdName: 'management.key', sourcePath: '/etc/qwen38-workload-manager/credentials/management.key', requiredMode: '0600' },
    },
    paths: { runtimeDirectory: '/run/qwen38-workload-manager', stateDirectory: '/var/lib/qwen38-workload-manager', cacheDirectory: '/var/cache/qwen38-workload-manager', logDirectory: '/var/log/qwen38-workload-manager' },
  };
}

function getMetrics(server: import('node:http').Server, key: string): Promise<string> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port, path: '/metrics', headers: { authorization: `Bearer ${key}` } }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve(text));
    });
    client.on('error', reject); client.end();
  });
}
