export interface SupervisorConfig {
  readonly binary: string;
  readonly host: '127.0.0.1';
  readonly port: 18080;
  readonly approvedDevice: string;
}

export function parseSupervisorConfig(value: unknown): SupervisorConfig {
  if (!isRecord(value) || typeof value.binary !== 'string' || value.binary.length === 0 || value.host !== '127.0.0.1' || value.port !== 18080 || typeof value.approvedDevice !== 'string' || value.approvedDevice.length === 0) {
    throw new Error('invalid_supervisor_config');
  }
  return Object.freeze({ binary: value.binary, host: value.host, port: value.port, approvedDevice: value.approvedDevice });
}

export const FIXED_CATALOG_IDS = Object.freeze([
  'qwen3.8-27b', 'qwen3.8-27b-uncensored', 'qwen3.8-27b-q4', 'qwen3.8-27b-uncensored-q4',
] as const);

export interface GatewayLimits {
  readonly inferenceBodyBytes: number;
  readonly controlBodyBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxHeaderCount: number;
  readonly maxLocalEngineRequests: number;
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly childConnectHeadersTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly totalRequestTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly retryAfterSeconds: number;
}

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = Object.freeze({
  inferenceBodyBytes: 8 * 1024 * 1024, controlBodyBytes: 64 * 1024,
  maxHeaderBytes: 16 * 1024, maxHeaderCount: 64, maxLocalEngineRequests: 1,
  headersTimeoutMs: 15_000, requestTimeoutMs: 60_000,
  childConnectHeadersTimeoutMs: 30_000, streamIdleTimeoutMs: 300_000,
  totalRequestTimeoutMs: 2 * 60 * 60 * 1000, drainTimeoutMs: 2 * 60 * 60 * 1000,
  keepAliveTimeoutMs: 5_000, retryAfterSeconds: 5,
});

export interface ManagerServerConfig {
  readonly inferenceKey: string;
  readonly managementKey: string;
  readonly childEndpoint: string;
  readonly catalogIds?: readonly string[];
  readonly limits?: Partial<GatewayLimits>;
  readonly trustedLanCidr?: '192.168.3.0/24';
}

export interface ValidatedManagerServerConfig extends Omit<ManagerServerConfig, 'catalogIds' | 'limits' | 'trustedLanCidr'> {
  readonly catalogIds: readonly string[];
  readonly limits: GatewayLimits;
  readonly trustedLanCidr: '192.168.3.0/24';
}

export function parseManagerServerConfig(value: unknown): ValidatedManagerServerConfig {
  if (!isRecord(value) || Object.keys(value).some((key) => !new Set(['inferenceKey', 'managementKey', 'childEndpoint', 'catalogIds', 'limits', 'trustedLanCidr']).has(key)) || !validKey(value.inferenceKey) || !validKey(value.managementKey) || value.inferenceKey.toLowerCase() === value.managementKey.toLowerCase() || typeof value.childEndpoint !== 'string' || (value.trustedLanCidr !== undefined && value.trustedLanCidr !== '192.168.3.0/24')) throw new Error('invalid_manager_server_config');
  const endpoint = parseChildEndpoint(value.childEndpoint);
  const catalog = value.catalogIds === undefined ? FIXED_CATALOG_IDS : value.catalogIds;
  if (!Array.isArray(catalog) || catalog.length !== FIXED_CATALOG_IDS.length || new Set(catalog).size !== FIXED_CATALOG_IDS.length || !catalog.every((entry, index) => entry === FIXED_CATALOG_IDS[index])) throw new Error('invalid_manager_server_config');
  const limits = validateLimits(value.limits);
  return Object.freeze({ inferenceKey: value.inferenceKey, managementKey: value.managementKey, childEndpoint: endpoint.href, catalogIds: Object.freeze([...catalog]), limits, trustedLanCidr: '192.168.3.0/24' });
}

export function parseChildEndpoint(value: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error('invalid_child_endpoint'); }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== '18080' || endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.hash !== '' || endpoint.username !== '' || endpoint.password !== '') throw new Error('invalid_child_endpoint');
  return endpoint;
}

function validateLimits(value: unknown): GatewayLimits {
  if (value !== undefined && (!isRecord(value) || Object.keys(value).some((key) => !(key in DEFAULT_GATEWAY_LIMITS)))) throw new Error('invalid_gateway_limits');
  const resolved = { ...DEFAULT_GATEWAY_LIMITS, ...(value ?? {}) } as GatewayLimits;
  for (const key of Object.keys(DEFAULT_GATEWAY_LIMITS) as Array<keyof GatewayLimits>) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0 || resolved[key] > DEFAULT_GATEWAY_LIMITS[key]) throw new Error('invalid_gateway_limits');
  }
  return Object.freeze(resolved);
}

function validKey(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
