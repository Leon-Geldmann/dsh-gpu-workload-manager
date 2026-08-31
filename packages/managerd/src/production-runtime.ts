import { isAbsolute, normalize } from 'node:path';
import type { ModelSpec } from '@local/gpu-workload-core';
import { ChildSupervisor } from './child-supervisor.js';
import {
  pinArtifact as defaultPinArtifact,
  revalidatePinnedArtifact as defaultRevalidatePinnedArtifact,
  type ArtifactExpectation,
  type ArtifactPin,
  type ArtifactValidationOptions,
} from './file-integrity.js';
import type { ProductionCatalogConfig, ProductionModelArtifact } from './runtime-config.js';
import type { ProductionManagerConfig } from './runtime-config.js';
import type { OpenedSystemdCredentials } from './runtime-credentials.js';
import { ManagerEngine, type EngineSnapshot } from './manager-engine.js';
import { createManagerServer, type ManagerServer } from './server.js';
import { Metrics } from './metrics.js';

export interface ArtifactGate {
  validateArtifacts(model: ModelSpec): Promise<void>;
}

export interface ArtifactGateDependencies {
  readonly pinArtifact: (expectation: ArtifactExpectation, options?: ArtifactValidationOptions) => Promise<ArtifactPin>;
  readonly revalidatePinnedArtifact: (expectation: ArtifactExpectation, pin: ArtifactPin, options?: ArtifactValidationOptions) => Promise<ArtifactPin>;
}

export interface RuntimeArguments {
  readonly managerConfigPath: '/etc/qwen38-workload-manager/manager.production.json';
  readonly modelsConfigPath: '/etc/qwen38-workload-manager/models.production.json';
}

export interface ProductionRuntime {
  readonly server: ManagerServer;
  snapshot(): EngineSnapshot;
  listen(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ProductionRuntimeDependencies {
  readonly artifacts?: ArtifactGateDependencies;
  readonly metrics?: Metrics;
}

export async function createArtifactGate(
  catalog: ProductionCatalogConfig,
  trustedOwnerUids: readonly number[],
  dependencies: ArtifactGateDependencies = {
    pinArtifact: defaultPinArtifact,
    revalidatePinnedArtifact: defaultRevalidatePinnedArtifact,
  },
  signal?: AbortSignal,
): Promise<ArtifactGate> {
  if (!Array.isArray(trustedOwnerUids) || trustedOwnerUids.length === 0
    || trustedOwnerUids.some((uid) => !Number.isSafeInteger(uid) || uid < 0)
    || new Set(trustedOwnerUids).size !== trustedOwnerUids.length) throw new Error('invalid_trusted_owner_uids');
  const options: ArtifactValidationOptions = Object.freeze({
    trustedOwnerUids: Object.freeze([...trustedOwnerUids]),
    ...(signal === undefined ? {} : { signal }),
  });
  const models = new Map(catalog.models.map((model) => [model.id, model]));
  const pins = new Map<string, ArtifactPin>();

  pins.set(catalog.binary.path, await dependencies.pinArtifact(catalog.binary, options));
  for (const model of catalog.models) pins.set(model.path, await dependencies.pinArtifact(artifactExpectation(model), options));

  let priorValidation = Promise.resolve();
  return Object.freeze({
    validateArtifacts(model: ModelSpec): Promise<void> {
      const configured = models.get(model.id);
      if (configured === undefined || !sameModel(configured, model)) return Promise.reject(new Error('model_not_in_production_catalog'));
      const work = priorValidation.then(async () => {
        const binaryPin = requirePin(pins, catalog.binary.path);
        pins.set(catalog.binary.path, await dependencies.revalidatePinnedArtifact(catalog.binary, binaryPin, options));
        const modelPin = requirePin(pins, configured.path);
        pins.set(configured.path, await dependencies.revalidatePinnedArtifact(artifactExpectation(configured), modelPin, options));
      });
      priorValidation = work.then(() => undefined, () => undefined);
      return work;
    },
  });
}

function artifactExpectation(model: ProductionModelArtifact): ArtifactExpectation {
  return Object.freeze({ path: model.path, bytes: model.bytes, sha256: model.sha256 });
}

export function parseRuntimeArguments(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeArguments {
  const directory = environment.CREDENTIALS_DIRECTORY;
  if (directory === undefined || !canonicalAbsolutePath(directory)
    || argv.length !== 4
    || argv[0] !== '--manager-config' || argv[1] !== '/etc/qwen38-workload-manager/manager.production.json'
    || argv[2] !== '--models-config' || argv[3] !== '/etc/qwen38-workload-manager/models.production.json') {
    throw new Error('invalid_runtime_arguments');
  }
  return Object.freeze({
    managerConfigPath: '/etc/qwen38-workload-manager/manager.production.json',
    modelsConfigPath: '/etc/qwen38-workload-manager/models.production.json',
  });
}

export async function createProductionRuntime(
  manager: ProductionManagerConfig,
  catalog: ProductionCatalogConfig,
  credentials: OpenedSystemdCredentials,
  dependencies: ProductionRuntimeDependencies = {},
): Promise<ProductionRuntime> {
  let runtime: ProductionRuntime | undefined;
  try {
    const gate = await createArtifactGate(catalog, manager.artifactIntegrity.trustedOwnerUids, dependencies.artifacts);
    const metrics = dependencies.metrics ?? new Metrics(catalog.models.map((model) => model.id));
    const supervisor = new ChildSupervisor({
      binary: catalog.binary.path,
      credentialFd: credentials.inferenceFd,
      inferenceKey: credentials.inferenceKey,
      catalog: catalog.models,
      approvedDevice: manager.child.approvedDevice,
      deviceMatcher: new RegExp(manager.child.deviceMatcher),
      stopTimeoutMs: 60_000,
      deviceEnumerationTimeoutMs: 30_000,
      healthTimeoutMs: 30 * 60_000,
      pollIntervalMs: 500,
      validateArtifacts: (model) => gate.validateArtifacts(model),
      host: manager.child.host,
      port: manager.child.port,
      telemetry: metrics,
    });
    const engine = new ManagerEngine({ catalog: catalog.models, supervisor, telemetry: metrics });
    const server = createManagerServer({
      inferenceKey: credentials.inferenceKey,
      managementKey: credentials.managementKey,
      childEndpoint: `http://${manager.child.host}:${manager.child.port}`,
      catalogIds: catalog.models.map((model) => model.id),
      trustedLanCidr: manager.networkPolicy.trustedIpv4Cidrs[0],
    }, engine, { metrics });
    let shutdownPromise: Promise<void> | undefined;
    runtime = Object.freeze({
      server,
      snapshot: () => engine.snapshot(),
      listen: () => listenServer(server, manager.listen.host, manager.listen.port),
      shutdown: () => shutdownPromise ??= server.shutdown().finally(() => credentials.close()),
    });
    return runtime;
  } catch (error) {
    credentials.close();
    throw error;
  }
}

function sameModel(configured: ProductionModelArtifact, requested: ModelSpec): boolean {
  return requested.id === configured.id && requested.path === configured.path
    && requested.contextSize === configured.contextSize && requested.mtp === configured.mtp;
}

function requirePin(pins: ReadonlyMap<string, ArtifactPin>, path: string): ArtifactPin {
  const pin = pins.get(path);
  if (pin === undefined) throw new Error('artifact_pin_missing');
  return pin;
}

function canonicalAbsolutePath(path: string): boolean {
  return path.length > 1 && !path.includes('\0') && isAbsolute(path) && normalize(path) === path;
}

function listenServer(server: ManagerServer, host: '0.0.0.0', port: 8080): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = () => { server.off('error', onError); resolve(); };
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen({ host, port });
  });
}
