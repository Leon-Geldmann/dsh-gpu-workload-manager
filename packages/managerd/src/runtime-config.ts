import { isAbsolute, normalize } from 'node:path';
import type { ArtifactExpectation } from './file-integrity.js';

const MODEL_PROFILES = Object.freeze([
  ['qwen3.8-27b', 65_536, 2],
  ['qwen3.8-27b-uncensored', 65_536, 2],
  ['qwen3.8-27b-q4', 131_072, 5],
  ['qwen3.8-27b-uncensored-q4', 131_072, 2],
] as const);

export interface ProductionModelArtifact extends ArtifactExpectation {
  readonly id: string;
  readonly contextSize: number;
  readonly mtp: number;
}

export interface ProductionCatalogConfig {
  readonly version: 1;
  readonly binary: ArtifactExpectation;
  readonly models: readonly ProductionModelArtifact[];
}

export interface ProductionManagerConfig {
  readonly version: 1;
  readonly startup: {
    readonly mode: 'manual';
    readonly initialState: 'UNLOADED';
    readonly autoLoad: false;
    readonly restoreLastModel: false;
  };
  readonly listen: { readonly host: '0.0.0.0'; readonly port: 8080; readonly addressFamily: 'ipv4' };
  readonly networkPolicy: {
    readonly trustedIpv4Cidrs: readonly ['192.168.3.0/24'];
    readonly enforcement: readonly ['ufw', 'preflight'];
    readonly ipv6: false;
  };
  readonly child: {
    readonly host: '127.0.0.1';
    readonly port: 18080;
    readonly approvedDevice: 'Vulkan0';
    readonly deviceMatcher: '^Vulkan0: AMD Radeon RX 7900 XTX \\(RADV NAVI31\\)$';
    readonly parallel: 1;
    readonly gpuLayers: 'all';
    readonly flashAttention: true;
    readonly kvCache: 'q8_0';
  };
  readonly catalogPath: '/etc/qwen38-workload-manager/models.production.json';
  readonly artifactIntegrity: {
    readonly mode: 'strict';
    readonly trustedOwnerUids: readonly [0, 1001];
    readonly maximumGroupWritableExceptionTtlMs: 86_400_000;
  };
  readonly credentials: {
    readonly inference: ProductionCredentialConfig;
    readonly management: ProductionCredentialConfig;
  };
  readonly paths: {
    readonly runtimeDirectory: '/run/qwen38-workload-manager';
    readonly stateDirectory: '/var/lib/qwen38-workload-manager';
    readonly cacheDirectory: '/var/cache/qwen38-workload-manager';
    readonly logDirectory: '/var/log/qwen38-workload-manager';
  };
}

export interface ProductionCredentialConfig {
  readonly systemdName: 'inference.key' | 'management.key';
  readonly sourcePath: '/etc/qwen38-workload-manager/credentials/inference.key' | '/etc/qwen38-workload-manager/credentials/management.key';
  readonly requiredMode: '0600';
}

export function parseProductionCatalog(value: unknown): ProductionCatalogConfig {
  try {
    requireRecord(value, ['version', 'binary', 'models']);
    if (value.version !== 1 || !Array.isArray(value.models) || value.models.length !== MODEL_PROFILES.length) failCatalog();
    const binary = parseArtifact(value.binary);
    const models = value.models.map((candidate, index) => parseModel(candidate, MODEL_PROFILES[index]!));
    if (new Set([binary.path, ...models.map((model) => model.path)]).size !== models.length + 1) failCatalog();
    return Object.freeze({ version: 1, binary, models: Object.freeze(models) });
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_production_catalog') throw error;
    throw new Error('invalid_production_catalog');
  }
}

export function parseProductionManagerConfig(value: unknown): ProductionManagerConfig {
  try {
    requireRecord(value, ['version', 'startup', 'listen', 'networkPolicy', 'child', 'catalogPath', 'artifactIntegrity', 'credentials', 'paths']);
    if (value.version !== 1) failManager();

    requireRecord(value.startup, ['mode', 'initialState', 'autoLoad', 'restoreLastModel']);
    if (value.startup.mode !== 'manual' || value.startup.initialState !== 'UNLOADED' || value.startup.autoLoad !== false || value.startup.restoreLastModel !== false) failManager();

    requireRecord(value.listen, ['host', 'port', 'addressFamily']);
    if (value.listen.host !== '0.0.0.0' || value.listen.port !== 8080 || value.listen.addressFamily !== 'ipv4') failManager();

    requireRecord(value.networkPolicy, ['trustedIpv4Cidrs', 'enforcement', 'ipv6']);
    if (!exactArray(value.networkPolicy.trustedIpv4Cidrs, ['192.168.3.0/24']) || !exactArray(value.networkPolicy.enforcement, ['ufw', 'preflight']) || value.networkPolicy.ipv6 !== false) failManager();

    requireRecord(value.child, ['host', 'port', 'approvedDevice', 'deviceMatcher', 'parallel', 'gpuLayers', 'flashAttention', 'kvCache']);
    if (value.child.host !== '127.0.0.1' || value.child.port !== 18080 || value.child.approvedDevice !== 'Vulkan0'
      || value.child.deviceMatcher !== '^Vulkan0: AMD Radeon RX 7900 XTX \\(RADV NAVI31\\)$'
      || value.child.parallel !== 1 || value.child.gpuLayers !== 'all' || value.child.flashAttention !== true || value.child.kvCache !== 'q8_0') failManager();

    if (value.catalogPath !== '/etc/qwen38-workload-manager/models.production.json') failManager();

    requireRecord(value.artifactIntegrity, ['mode', 'trustedOwnerUids', 'maximumGroupWritableExceptionTtlMs']);
    if (value.artifactIntegrity.mode !== 'strict' || !exactArray(value.artifactIntegrity.trustedOwnerUids, [0, 1001]) || value.artifactIntegrity.maximumGroupWritableExceptionTtlMs !== 86_400_000) failManager();

    requireRecord(value.credentials, ['inference', 'management']);
    const inference = parseCredential(value.credentials.inference, 'inference.key', '/etc/qwen38-workload-manager/credentials/inference.key');
    const management = parseCredential(value.credentials.management, 'management.key', '/etc/qwen38-workload-manager/credentials/management.key');

    requireRecord(value.paths, ['runtimeDirectory', 'stateDirectory', 'cacheDirectory', 'logDirectory']);
    if (value.paths.runtimeDirectory !== '/run/qwen38-workload-manager'
      || value.paths.stateDirectory !== '/var/lib/qwen38-workload-manager'
      || value.paths.cacheDirectory !== '/var/cache/qwen38-workload-manager'
      || value.paths.logDirectory !== '/var/log/qwen38-workload-manager') failManager();

    return Object.freeze({
      version: 1,
      startup: Object.freeze({ mode: 'manual', initialState: 'UNLOADED', autoLoad: false, restoreLastModel: false }),
      listen: Object.freeze({ host: '0.0.0.0', port: 8080, addressFamily: 'ipv4' }),
      networkPolicy: Object.freeze({ trustedIpv4Cidrs: Object.freeze(['192.168.3.0/24']) as readonly ['192.168.3.0/24'], enforcement: Object.freeze(['ufw', 'preflight']) as readonly ['ufw', 'preflight'], ipv6: false }),
      child: Object.freeze({ host: '127.0.0.1', port: 18080, approvedDevice: 'Vulkan0', deviceMatcher: '^Vulkan0: AMD Radeon RX 7900 XTX \\(RADV NAVI31\\)$', parallel: 1, gpuLayers: 'all', flashAttention: true, kvCache: 'q8_0' }),
      catalogPath: '/etc/qwen38-workload-manager/models.production.json',
      artifactIntegrity: Object.freeze({ mode: 'strict', trustedOwnerUids: Object.freeze([0, 1001]) as readonly [0, 1001], maximumGroupWritableExceptionTtlMs: 86_400_000 }),
      credentials: Object.freeze({ inference, management }),
      paths: Object.freeze({ runtimeDirectory: '/run/qwen38-workload-manager', stateDirectory: '/var/lib/qwen38-workload-manager', cacheDirectory: '/var/cache/qwen38-workload-manager', logDirectory: '/var/log/qwen38-workload-manager' }),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_production_manager_config') throw error;
    throw new Error('invalid_production_manager_config');
  }
}

function parseModel(value: unknown, profile: typeof MODEL_PROFILES[number]): ProductionModelArtifact {
  requireRecord(value, ['id', 'path', 'bytes', 'sha256', 'contextSize', 'mtp']);
  const artifact = parseArtifact({ path: value.path, bytes: value.bytes, sha256: value.sha256 });
  if (value.id !== profile[0] || value.contextSize !== profile[1] || value.mtp !== profile[2]) failCatalog();
  return Object.freeze({ id: profile[0], ...artifact, contextSize: profile[1], mtp: profile[2] });
}

function parseArtifact(value: unknown): ArtifactExpectation {
  requireRecord(value, ['path', 'bytes', 'sha256']);
  if (typeof value.path !== 'string' || !canonicalAbsolutePath(value.path)
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) failCatalog();
  return Object.freeze({ path: value.path, bytes: value.bytes as number, sha256: value.sha256 });
}

function parseCredential(value: unknown, systemdName: ProductionCredentialConfig['systemdName'], sourcePath: ProductionCredentialConfig['sourcePath']): ProductionCredentialConfig {
  requireRecord(value, ['systemdName', 'sourcePath', 'requiredMode']);
  if (value.systemdName !== systemdName || value.sourcePath !== sourcePath || value.requiredMode !== '0600') failManager();
  return Object.freeze({ systemdName, sourcePath, requiredMode: '0600' });
}

function requireRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('invalid_shape');
}

function exactArray(value: unknown, expected: readonly unknown[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function canonicalAbsolutePath(path: string): boolean {
  return path.length > 1 && !path.includes('\0') && isAbsolute(path) && normalize(path) === path;
}

function failCatalog(): never { throw new Error('invalid_production_catalog'); }
function failManager(): never { throw new Error('invalid_production_manager_config'); }
