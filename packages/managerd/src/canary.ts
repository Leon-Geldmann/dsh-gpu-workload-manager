import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelSpec } from '@local/gpu-workload-core';
import { ChildSupervisor } from './child-supervisor.js';
import { ManagerEngine } from './manager-engine.js';
import { createManagerServer, type ManagerServer } from './server.js';
import type { ChildRequestFactory } from './inference-proxy.js';
import { openSystemdCredentials, type OpenedSystemdCredentials } from './runtime-credentials.js';
import { createArtifactGate } from './production-runtime.js';
import { parseProductionCatalog, parseProductionManagerConfig, type ProductionCatalogConfig, type ProductionManagerConfig } from './runtime-config.js';

interface CanaryEnvironmentBase {
  readonly kind: 'fake' | 'real';
  readonly releaseDirectory: string;
  readonly managerConfigPath: string;
  readonly modelsConfigPath: string;
}

interface FullCanaryEnvironment extends CanaryEnvironmentBase {
  readonly mode: 'full';
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly childPort: number;
}

interface ArtifactOnlyCanaryEnvironment extends CanaryEnvironmentBase {
  readonly kind: 'real';
  readonly mode: 'artifact-only';
}

type CanaryEnvironment = FullCanaryEnvironment | ArtifactOnlyCanaryEnvironment;

export async function runCanary(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  signal?: AbortSignal,
): Promise<void> {
  const config = parseCanaryEnvironment(environment);
  assertNotAborted(signal);
  if (config.mode === 'artifact-only') {
    try {
      const production = await readProductionConfig(config);
      assertNotAborted(signal);
      await createArtifactGate(production.catalog, production.manager.artifactIntegrity.trustedOwnerUids, undefined, signal);
      assertNotAborted(signal);
      return;
    } catch (error) {
      if (signal?.aborted) throw new Error('canary_aborted');
      throw error;
    }
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'qwen38-canary-'));
  let credentials: OpenedSystemdCredentials | undefined;
  let server: ManagerServer | undefined;
  let engine: ManagerEngine | undefined;
  let supervisor: ChildSupervisor | undefined;
  let runningPid: number | undefined;
  let abortCleanup: Promise<void> | undefined;
  const cleanupOnAbort = (): void => {
    abortCleanup ??= (async () => {
      await supervisor?.forceStop('canary_aborted').catch(() => undefined);
      if (server !== undefined) await server.shutdown().catch(() => undefined);
      else if (engine !== undefined) await engine.shutdown().catch(() => undefined);
    })();
  };
  signal?.addEventListener('abort', cleanupOnAbort);
  try {
    credentials = openSystemdCredentials(environment);
    const production = config.kind === 'real' ? await readProductionConfig(config) : undefined;
    assertNotAborted(signal);
    const catalog = production?.catalog ?? fakeCatalog(join(temporaryDirectory, 'fake.gguf'));
    const manager = production?.manager;
    let binary: string;
    let validateArtifacts: (model: ModelSpec) => Promise<void>;
    if (config.kind === 'real') {
      const gate = await createArtifactGate(catalog, manager!.artifactIntegrity.trustedOwnerUids);
      binary = catalog.binary.path;
      validateArtifacts = (model) => gate.validateArtifacts(model);
    } else {
      binary = await writeFakeBinary(temporaryDirectory);
      await writeFile(catalog.models[0]!.path, 'fake model', { mode: 0o600 });
      validateArtifacts = async () => undefined;
    }

    supervisor = new ChildSupervisor({
      binary,
      credentialFd: credentials.inferenceFd,
      inferenceKey: credentials.inferenceKey,
      catalog: catalog.models,
      approvedDevice: 'Vulkan0',
      deviceMatcher: /^Vulkan0: AMD Radeon RX 7900 XTX \(RADV NAVI31\)$/,
      stopTimeoutMs: 60_000,
      deviceEnumerationTimeoutMs: config.kind === 'real' ? 30_000 : 5_000,
      healthTimeoutMs: config.kind === 'real' ? 30 * 60_000 : 5_000,
      pollIntervalMs: config.kind === 'real' ? 500 : 10,
      validateArtifacts,
      host: '127.0.0.1',
      port: config.childPort,
    });
    engine = new ManagerEngine({ catalog: catalog.models, supervisor });
    server = createManagerServer({
      inferenceKey: credentials.inferenceKey,
      managementKey: credentials.managementKey,
      childEndpoint: 'http://127.0.0.1:18080',
      catalogIds: catalog.models.map((model) => model.id),
    }, engine, { childRequest: childRequestAt(config.childPort) });
    assertNotAborted(signal);
    await listenLoopback(server, config.port);
    const address = server.address();
    if (address === null || typeof address === 'string' || address.address !== '127.0.0.1' || address.family !== 'IPv4') throw new Error('canary_bind_attestation_failed');
    const origin = `http://127.0.0.1:${config.port}`;

    const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5_000) });
    if (health.status !== 200) throw new Error('canary_health_failed');
    assertNotAborted(signal);
    await submitOperation(origin, credentials.managementKey, { action: 'load', model: catalog.models[0]!.id, onBusy: 'reject' });
    await engine.whenSettled();
    assertNotAborted(signal);
    if (engine.snapshot().phase !== 'READY' || engine.snapshot().activeModel !== catalog.models[0]!.id) throw new Error('canary_load_failed');
    runningPid = supervisor.snapshot().childPid;
    if (runningPid === undefined) throw new Error('canary_child_missing');

    const body = JSON.stringify({ model: catalog.models[0]!.id, stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'canary' }] });
    const unauthorized = await fetch(`${origin}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5_000) });
    if (unauthorized.status !== 401) throw new Error('canary_unauthorized_boundary_failed');
    assertNotAborted(signal);
    const inference = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${credentials.inferenceKey}`, 'content-type': 'application/json' }, body,
      signal: AbortSignal.timeout(config.kind === 'real' ? 10 * 60_000 : 5_000),
    });
    if (inference.status !== 200 || !hasCompletionToken(await inference.json())) throw new Error('canary_inference_failed');

    assertNotAborted(signal);
    await submitOperation(origin, credentials.managementKey, { action: 'unload', onBusy: 'reject' });
    await engine.whenSettled();
    assertNotAborted(signal);
    if (engine.snapshot().phase !== 'UNLOADED' || supervisor.snapshot().childPid !== undefined || pidAlive(runningPid)) throw new Error('canary_unload_failed');
  } catch (error) {
    if (signal?.aborted) throw new Error('canary_aborted');
    throw error;
  } finally {
    if (signal?.aborted) cleanupOnAbort();
    await abortCleanup;
    if (server !== undefined) await server.shutdown().catch(() => undefined);
    else if (engine !== undefined) await engine.shutdown().catch(() => undefined);
    signal?.removeEventListener('abort', cleanupOnAbort);
    credentials?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
    if (runningPid !== undefined && pidAlive(runningPid)) throw new Error('canary_residual_child');
  }
}

async function readProductionConfig(config: CanaryEnvironment): Promise<{ readonly manager: ProductionManagerConfig; readonly catalog: ProductionCatalogConfig }> {
  const [managerText, modelsText] = await Promise.all([
    readFile(config.managerConfigPath, 'utf8'), readFile(config.modelsConfigPath, 'utf8'),
  ]);
  if (managerText.length > 1024 * 1024 || modelsText.length > 1024 * 1024) throw new Error('invalid_canary_config');
  const manager = parseProductionManagerConfig(JSON.parse(managerText) as unknown);
  const catalog = parseProductionCatalog(JSON.parse(modelsText) as unknown);
  return Object.freeze({ manager, catalog });
}

function fakeCatalog(modelPath: string): ProductionCatalogConfig {
  const profile = [
    ['qwen3.8-27b', 65_536, 2], ['qwen3.8-27b-uncensored', 65_536, 2],
    ['qwen3.8-27b-q4', 131_072, 5], ['qwen3.8-27b-uncensored-q4', 131_072, 2],
  ] as const;
  return Object.freeze({
    version: 1,
    binary: Object.freeze({ path: '/fake/llama-server', bytes: 1, sha256: 'a'.repeat(64) }),
    models: Object.freeze(profile.map(([id, contextSize, mtp], index) => Object.freeze({
      id, path: index === 0 ? modelPath : `${modelPath}.${index}`, bytes: 1, sha256: String(index + 1).repeat(64), contextSize, mtp,
    }))),
  });
}

async function writeFakeBinary(directory: string): Promise<string> {
  const binary = join(directory, 'fake-llama-server');
  const childModule = join(directory, 'fake-child.mjs');
  await writeFile(childModule, FAKE_CHILD_SOURCE, { mode: 0o600 });
  const script = `#!/bin/sh\nif [ "$1" = "--list-devices" ]; then\n  printf '%s\\n' 'Vulkan0: AMD Radeon RX 7900 XTX (RADV NAVI31)'\n  exit 0\nfi\nexec ${shellQuote(process.execPath)} ${shellQuote(childModule)} "$@"\n`;
  await writeFile(binary, script, { mode: 0o700 });
  await chmod(binary, 0o700);
  return binary;
}

async function submitOperation(origin: string, managementKey: string, intent: { readonly action: 'load' | 'unload'; readonly model?: string; readonly onBusy: 'reject' }): Promise<void> {
  const response = await fetch(`${origin}/gpu/v1/operations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${managementKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: randomUUID(), ...intent }),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 200 && response.status !== 202) throw new Error('canary_operation_failed');
}

function childRequestAt(port: number): ChildRequestFactory {
  return ((options: any, callback: any) => httpRequest({
    ...options,
    hostname: '127.0.0.1',
    host: '127.0.0.1',
    port,
    headers: { ...options.headers, host: `127.0.0.1:${port}` },
  }, callback)) as ChildRequestFactory;
}

function listenLoopback(server: ManagerServer, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolvePromise(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function parseCanaryEnvironment(environment: Readonly<Record<string, string | undefined>>): CanaryEnvironment {
  const kind = environment.QWEN38_CANARY_KIND;
  const mode = environment.QWEN38_CANARY_MODE;
  const host = environment.QWEN38_CANARY_HOST;
  const releaseDirectory = environment.QWEN38_RELEASE_DIR;
  const managerConfigPath = environment.QWEN38_MANAGER_CONFIG;
  const modelsConfigPath = environment.QWEN38_MODELS_CONFIG;
  if (!canonicalPath(releaseDirectory) || !canonicalPath(managerConfigPath) || !canonicalPath(modelsConfigPath)) invalidEnvironment();
  if (mode === 'artifact-only') {
    if (kind !== 'real' || host !== undefined || environment.QWEN38_CANARY_PORT !== undefined
      || environment.QWEN38_CANARY_CHILD_PORT !== undefined || environment.CREDENTIALS_DIRECTORY !== undefined) invalidEnvironment();
    return Object.freeze({ kind: 'real', mode, releaseDirectory, managerConfigPath, modelsConfigPath });
  }
  const port = parsePort(environment.QWEN38_CANARY_PORT);
  const childPort = parsePort(environment.QWEN38_CANARY_CHILD_PORT);
  if (mode !== 'full' || (kind !== 'fake' && kind !== 'real') || host !== '127.0.0.1' || port === undefined || childPort === undefined
    || port === childPort || port === 8080 || port === 18080 || childPort === 8080 || childPort === 18080) invalidEnvironment();
  return Object.freeze({ kind, mode, host, port, childPort, releaseDirectory, managerConfigPath, modelsConfigPath });
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d{3,4}$/.test(value)) return undefined;
  const port = Number(value);
  return port <= 65_535 ? port : undefined;
}

function canonicalPath(value: string | undefined): value is string {
  return value !== undefined && value.length > 1 && !value.includes('\0') && isAbsolute(value) && normalize(value) === value;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\"'\"'`)}'`; }
function invalidEnvironment(): never { throw new Error('invalid_canary_environment'); }
function assertNotAborted(signal: AbortSignal | undefined): void { if (signal?.aborted) throw new Error('canary_aborted'); }
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function hasCompletionToken(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { choices?: unknown }).choices)) return false;
  return (value as { choices: Array<{ message?: { content?: unknown }; text?: unknown }> }).choices.some((choice) => typeof choice.text === 'string' && choice.text.length > 0 || typeof choice.message?.content === 'string' && choice.message.content.length > 0);
}

const FAKE_CHILD_SOURCE = String.raw`import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const port = Number(option('--port'));
const alias = option('--alias');
const contextSize = Number(option('--ctx-size'));
const apiKey = readFileSync(option('--api-key-file'), 'utf8').trim();
const send = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
const server = createServer((request, response) => {
  if (request.url === '/health') return send(response, 200, { status: 'ok' });
  if (request.headers.authorization !== 'Bearer ' + apiKey) return send(response, 401, { error: 'unauthorized' });
  if (request.url === '/props') return send(response, 200, { model_alias: alias, total_slots: 1, default_generation_settings: { n_ctx: contextSize } });
  if (request.url === '/v1/chat/completions' && request.method === 'POST') return send(response, 200, { choices: [{ message: { content: 'ok' } }], usage: { completion_tokens: 1 } });
  return send(response, 404, { error: 'not_found' });
});
server.listen(port, '127.0.0.1');
process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;

const directPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (import.meta.url === directPath) {
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = (): void => { interrupted = true; controller.abort(); };
  process.on('SIGTERM', interrupt);
  process.on('SIGINT', interrupt);
  void runCanary(process.env, controller.signal)
    .then(() => { if (interrupted) process.exitCode = 1; }, () => { process.exitCode = 1; })
    .finally(() => {
      process.off('SIGTERM', interrupt);
      process.off('SIGINT', interrupt);
    });
}
