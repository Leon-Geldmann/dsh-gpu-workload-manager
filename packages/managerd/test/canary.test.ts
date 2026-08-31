import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runCanary } from '../src/canary.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

it('runs the complete fake loopback gateway, authenticated chat, and graceful unload canary', async () => {
  const credentials = await mkdtemp(join(tmpdir(), 'gwm-canary-credentials-'));
  directories.push(credentials);
  await writeFile(join(credentials, 'inference.key'), 'a'.repeat(64), { mode: 0o600 });
  await writeFile(join(credentials, 'management.key'), 'b'.repeat(64), { mode: 0o600 });
  const [gatewayPort, childPort] = await freePorts();

  await expect(runCanary({
    QWEN38_CANARY_KIND: 'fake', QWEN38_CANARY_MODE: 'full', QWEN38_CANARY_HOST: '127.0.0.1',
    QWEN38_CANARY_PORT: String(gatewayPort), QWEN38_CANARY_CHILD_PORT: String(childPort),
    QWEN38_RELEASE_DIR: '/opt/qwen38-workload-manager/canary-test',
    QWEN38_MANAGER_CONFIG: '/etc/qwen38-workload-manager/manager.production.json',
    QWEN38_MODELS_CONFIG: '/etc/qwen38-workload-manager/models.production.json',
    CREDENTIALS_DIRECTORY: credentials,
  })).resolves.toBeUndefined();

  await expect(canBind(gatewayPort)).resolves.toBe(true);
  await expect(canBind(childPort)).resolves.toBe(true);
});

it('rejects a non-loopback or production-port canary contract before opening credentials', async () => {
  const base = {
    QWEN38_CANARY_KIND: 'fake', QWEN38_CANARY_MODE: 'full', QWEN38_CANARY_HOST: '0.0.0.0',
    QWEN38_CANARY_PORT: '18081', QWEN38_CANARY_CHILD_PORT: '18181',
    QWEN38_RELEASE_DIR: '/opt/release', QWEN38_MANAGER_CONFIG: '/etc/manager.json',
    QWEN38_MODELS_CONFIG: '/etc/models.json', CREDENTIALS_DIRECTORY: '/missing',
  };
  await expect(runCanary(base)).rejects.toThrow(/invalid_canary_environment/);
  await expect(runCanary({ ...base, QWEN38_CANARY_HOST: '127.0.0.1', QWEN38_CANARY_PORT: '8080' })).rejects.toThrow(/invalid_canary_environment/);
  await expect(runCanary({ ...base, QWEN38_CANARY_HOST: '127.0.0.1', QWEN38_CANARY_CHILD_PORT: '18080' })).rejects.toThrow(/invalid_canary_environment/);
});

it('aborts an in-progress canary and reaps its owned child before rejecting', async () => {
  const credentials = await mkdtemp(join(tmpdir(), 'gwm-canary-signal-'));
  directories.push(credentials);
  await writeFile(join(credentials, 'inference.key'), 'a'.repeat(64), { mode: 0o600 });
  await writeFile(join(credentials, 'management.key'), 'b'.repeat(64), { mode: 0o600 });
  const [gatewayPort, childPort] = await freePorts();
  const controller = new AbortController();
  const running = runCanary({
    QWEN38_CANARY_KIND: 'fake', QWEN38_CANARY_MODE: 'full', QWEN38_CANARY_HOST: '127.0.0.1',
    QWEN38_CANARY_PORT: String(gatewayPort), QWEN38_CANARY_CHILD_PORT: String(childPort),
    QWEN38_RELEASE_DIR: '/opt/qwen38-workload-manager/canary-signal-test',
    QWEN38_MANAGER_CONFIG: '/etc/qwen38-workload-manager/manager.production.json',
    QWEN38_MODELS_CONFIG: '/etc/qwen38-workload-manager/models.production.json',
    CREDENTIALS_DIRECTORY: credentials,
  }, controller.signal);

  await waitForHealth(childPort);
  controller.abort();
  await expect(running).rejects.toThrow(/canary_aborted/);
  await expect(canBind(gatewayPort)).resolves.toBe(true);
  await expect(canBind(childPort)).resolves.toBe(true);
});

it('validates every production artifact without credentials, listeners, GPU enumeration, or a child', async () => {
  const fixture = await productionArtifactFixture();

  await expect(runCanary({
    QWEN38_CANARY_KIND: 'real',
    QWEN38_CANARY_MODE: 'artifact-only',
    QWEN38_RELEASE_DIR: fixture.releaseDirectory,
    QWEN38_MANAGER_CONFIG: fixture.managerConfigPath,
    QWEN38_MODELS_CONFIG: fixture.modelsConfigPath,
  })).resolves.toBeUndefined();
});

it('rejects a digest mismatch in the last production artifact', async () => {
  const fixture = await productionArtifactFixture({ corruptLastDigest: true });

  await expect(runCanary({
    QWEN38_CANARY_KIND: 'real',
    QWEN38_CANARY_MODE: 'artifact-only',
    QWEN38_RELEASE_DIR: fixture.releaseDirectory,
    QWEN38_MANAGER_CONFIG: fixture.managerConfigPath,
    QWEN38_MODELS_CONFIG: fixture.modelsConfigPath,
  })).rejects.toThrow(/artifact_sha256_mismatch/);
});

it('fails closed unless artifact-only is an exact explicit real-canary mode', async () => {
  const base = {
    QWEN38_CANARY_KIND: 'real',
    QWEN38_CANARY_MODE: 'artifact-only',
    QWEN38_RELEASE_DIR: '/opt/release',
    QWEN38_MANAGER_CONFIG: '/opt/release/config/manager.production.json',
    QWEN38_MODELS_CONFIG: '/opt/release/config/models.production.json',
  };

  await expect(runCanary({ ...base, QWEN38_CANARY_KIND: 'fake' })).rejects.toThrow(/invalid_canary_environment/);
  await expect(runCanary({ ...base, QWEN38_CANARY_MODE: 'artifact_only' })).rejects.toThrow(/invalid_canary_environment/);
  await expect(runCanary({ ...base, QWEN38_CANARY_PORT: '18081' })).rejects.toThrow(/invalid_canary_environment/);
  await expect(runCanary({ ...base, CREDENTIALS_DIRECTORY: '/run/credentials/unexpected' })).rejects.toThrow(/invalid_canary_environment/);
  await expect(runCanary({
    ...base,
    QWEN38_CANARY_MODE: undefined,
    QWEN38_CANARY_HOST: '127.0.0.1',
    QWEN38_CANARY_PORT: '18081',
    QWEN38_CANARY_CHILD_PORT: '18181',
    CREDENTIALS_DIRECTORY: '/missing',
  })).rejects.toThrow(/invalid_canary_environment/);
});

async function productionArtifactFixture(options: { readonly corruptLastDigest?: boolean } = {}): Promise<{
  readonly releaseDirectory: string;
  readonly managerConfigPath: string;
  readonly modelsConfigPath: string;
}> {
  const releaseDirectory = await mkdtemp(join(homedir(), '.gwm-artifact-canary-'));
  directories.push(releaseDirectory);
  const candidates = ['/usr/bin/true', '/usr/bin/false', '/usr/bin/printf', '/usr/bin/env', '/usr/bin/id'];
  const artifacts = await Promise.all(candidates.map(async (path) => {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`test_requires_regular_root_artifact:${path}`);
    const contents = await readFile(path);
    return { path, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
  }));
  const managerConfigPath = join(releaseDirectory, 'manager.production.json');
  const modelsConfigPath = join(releaseDirectory, 'models.production.json');
  await writeFile(managerConfigPath, JSON.stringify(productionManagerConfig()), { mode: 0o600 });
  const profiles = [
    ['qwen3.8-27b', 65_536, 2],
    ['qwen3.8-27b-uncensored', 65_536, 2],
    ['qwen3.8-27b-q4', 131_072, 5],
    ['qwen3.8-27b-uncensored-q4', 131_072, 2],
  ] as const;
  const models = profiles.map(([id, contextSize, mtp], index) => ({
    id,
    ...artifacts[index + 1]!,
    sha256: options.corruptLastDigest && index === profiles.length - 1 ? '0'.repeat(64) : artifacts[index + 1]!.sha256,
    contextSize,
    mtp,
  }));
  await writeFile(modelsConfigPath, JSON.stringify({ version: 1, binary: artifacts[0], models }), { mode: 0o600 });
  return { releaseDirectory, managerConfigPath, modelsConfigPath };
}

function productionManagerConfig(): unknown {
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

async function freePorts(): Promise<[number, number]> {
  const first = await freePort();
  let second = await freePort();
  while (second === first) second = await freePort();
  return [first, second];
}

async function freePort(): Promise<number> {
  const server = createServer();
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('missing_test_port'));
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

function canBind(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(20) });
      if (response.status === 200) return;
    } catch { /* child is not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('test_child_never_became_healthy');
}
