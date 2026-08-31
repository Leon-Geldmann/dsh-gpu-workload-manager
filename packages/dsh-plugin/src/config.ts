export type PluginRole = 'server' | 'client';

export interface PluginConfig {
  readonly role: PluginRole;
  readonly managerUrl?: string;
  readonly managementCredentialRef: string;
}

export interface ResolvedPluginConfig {
  readonly role: PluginRole;
  readonly managerUrl: string;
  readonly managementCredentialRef: string;
}

const CONFIG_KEYS = new Set(['role', 'managerUrl', 'managementCredentialRef']);
const CREDENTIAL_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parsePluginConfig(value: unknown): ResolvedPluginConfig {
  if (!isRecord(value) || Object.keys(value).some((key) => !CONFIG_KEYS.has(key))) {
    throw new Error('invalid_plugin_config');
  }
  const { role, managerUrl, managementCredentialRef } = value;
  if ((role !== 'server' && role !== 'client') || typeof managementCredentialRef !== 'string') {
    throw new Error('invalid_plugin_config');
  }
  if (!CREDENTIAL_REFERENCE.test(managementCredentialRef)) {
    throw new Error('invalid_credential_reference');
  }

  const resolvedUrl = managerUrl === undefined
    ? role === 'server' ? 'http://127.0.0.1:8080' : undefined
    : validateManagerUrl(managerUrl, role);
  if (resolvedUrl === undefined) throw new Error('invalid_manager_url');
  return Object.freeze({ role, managerUrl: resolvedUrl, managementCredentialRef });
}

function validateManagerUrl(value: unknown, role: PluginRole): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid_manager_url');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('invalid_manager_url'); }
  if (parsed.protocol !== 'http:' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '' || parsed.pathname !== '/' || parsed.port === '') {
    throw new Error('invalid_manager_url');
  }
  if (role === 'server' ? parsed.hostname !== '127.0.0.1' : !isPrivateLanIpv4(parsed.hostname)) {
    throw new Error('invalid_manager_url');
  }
  return parsed.origin;
}

function isPrivateLanIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
