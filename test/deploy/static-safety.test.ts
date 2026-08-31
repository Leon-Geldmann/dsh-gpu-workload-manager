import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProductionCatalog, parseProductionManagerConfig } from '../../packages/managerd/src/runtime-config.js';

const repository = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const modelsPath = join(repository, 'deploy/config/models.production.json');
const managerPath = join(repository, 'deploy/config/manager.production.json');
const unitPath = join(repository, 'deploy/systemd/qwen38-workload-manager.service');

let models: unknown;
let manager: unknown;
let unitText = '';
let unit: UnitSections;

beforeAll(async () => {
  models = JSON.parse(await readFile(modelsPath, 'utf8'));
  manager = JSON.parse(await readFile(managerPath, 'utf8'));
  unitText = await readFile(unitPath, 'utf8');
  unit = parseUnit(unitText);
});

describe('production catalog', () => {
  it('pins the exact llama.cpp binary and four approved model artifacts', () => {
    expect(models).toEqual({
      version: 1,
      binary: {
        path: '/home/agentops/apps/qwen38/build-vulkan/bin/llama-server',
        bytes: 61_287_200,
        sha256: 'fab17eebe2dfbf7d908beed09cea3b98ebc9e001ba767758262412bf9202980d',
      },
      models: [
        {
          id: 'qwen3.8-27b',
          path: '/data/ai/models/llm/qwen3.8-27b/base/unsloth-q5_k_m/Qwen3.8-27B-Q5_K_M.gguf',
          bytes: 19_834_055_648,
          sha256: '07deb7fa91bf751d3000774fe5bb8afae5ffb41255fd19980147468052e07177',
          contextSize: 65_536,
          mtp: 2,
        },
        {
          id: 'qwen3.8-27b-uncensored',
          path: '/data/ai/models/llm/qwen3.8-27b/uncensored/jonathancoletti-q5_k_m/Qwen3.8-27B-Uncensored-Q5_K_M.gguf',
          bytes: 19_535_701_408,
          sha256: '24780644a95f759a9aeeb228c3d852028f2fd40ce0b74d68134246ec4a959547',
          contextSize: 65_536,
          mtp: 2,
        },
        {
          id: 'qwen3.8-27b-q4',
          path: '/data/ai/models/llm/qwen3.8-27b/base/unsloth-q4_k_m/Qwen3.8-27B-Q4_K_M.gguf',
          bytes: 17_106_775_008,
          sha256: '7e78da5d7e3ae28d178121f58646953305f3e5bd3cb46f4a75584e8b6c6fe169',
          contextSize: 131_072,
          mtp: 5,
        },
        {
          id: 'qwen3.8-27b-uncensored-q4',
          path: '/data/ai/models/llm/qwen3.8-27b/uncensored-q4/jonathancoletti-q4_k_m/Qwen3.8-27B-Uncensored-Q4_K_M.gguf',
          bytes: 16_810_714_528,
          sha256: '4c5e2db039e9325ac7724c8846c71356a24ad1cdfa28002d73ecb6be645f9675',
          contextSize: 131_072,
          mtp: 2,
        },
      ],
    });
  });
});

describe('manager production policy', () => {
  it('is accepted by the strict production runtime parsers', () => {
    expect(parseProductionCatalog(models).models).toHaveLength(4);
    expect(parseProductionManagerConfig(manager).startup.initialState).toBe('UNLOADED');
  });

  it('starts empty and permits only manual model lifecycle operations', () => {
    expect(record(manager).version).toBe(1);
    expect(Object.keys(record(manager))).toEqual([
      'version', 'startup', 'listen', 'networkPolicy', 'child', 'catalogPath',
      'artifactIntegrity', 'credentials', 'paths',
    ]);
    expect(record(manager).startup).toEqual({
      mode: 'manual',
      initialState: 'UNLOADED',
      autoLoad: false,
      restoreLastModel: false,
    });
    expect(JSON.stringify(manager)).not.toMatch(/defaultModel|autoStart|modelsAutoload|models-autoload/i);
  });

  it('fixes the IPv4 gateway, loopback child, Vulkan device, and trusted LAN boundary', () => {
    expect(record(manager).listen).toEqual({ host: '0.0.0.0', port: 8080, addressFamily: 'ipv4' });
    expect(record(manager).networkPolicy).toEqual({
      trustedIpv4Cidrs: ['192.168.3.0/24'],
      enforcement: ['ufw', 'preflight'],
      ipv6: false,
    });
    expect(record(manager).child).toEqual({
      host: '127.0.0.1',
      port: 18080,
      approvedDevice: 'Vulkan0',
      deviceMatcher: '^Vulkan0: AMD Radeon RX 7900 XTX \\(RADV NAVI31\\)$',
      parallel: 1,
      gpuLayers: 'all',
      flashAttention: true,
      kvCache: 'q8_0',
    });
  });

  it('keeps artifact integrity strict without committing a live migration exception', () => {
    expect(record(manager).catalogPath).toBe('/etc/qwen38-workload-manager/models.production.json');
    expect(record(manager).artifactIntegrity).toEqual({
      mode: 'strict',
      trustedOwnerUids: [0, 1001],
      maximumGroupWritableExceptionTtlMs: 86_400_000,
    });
    expect(JSON.stringify(manager)).not.toMatch(/groupWritableAncestorException|operatorGroupMembership|expiresAt|"inode"|"dev"/);
  });

  it('declares distinct credential sources and only scoped runtime paths', () => {
    expect(record(manager).credentials).toEqual({
      inference: {
        systemdName: 'inference.key',
        sourcePath: '/etc/qwen38-workload-manager/credentials/inference.key',
        requiredMode: '0600',
      },
      management: {
        systemdName: 'management.key',
        sourcePath: '/etc/qwen38-workload-manager/credentials/management.key',
        requiredMode: '0600',
      },
    });
    expect(record(manager).paths).toEqual({
      runtimeDirectory: '/run/qwen38-workload-manager',
      stateDirectory: '/var/lib/qwen38-workload-manager',
      cacheDirectory: '/var/cache/qwen38-workload-manager',
      logDirectory: '/var/log/qwen38-workload-manager',
    });
    expect(JSON.stringify(manager)).not.toMatch(/"(?:inferenceKey|managementKey)"\s*:/);
  });
});

describe('hardened systemd service', () => {
  it('runs only the pinned Node 22 release entry as agentops with separate systemd credentials', () => {
    expect(values(unit, 'Service', 'User')).toEqual(['agentops']);
    expect(values(unit, 'Service', 'Group')).toEqual(['agentops']);
    expect(values(unit, 'Service', 'SupplementaryGroups')).toEqual(['aiops video render']);
    expect(values(unit, 'Service', 'LoadCredential')).toEqual([
      'inference.key:/etc/qwen38-workload-manager/credentials/inference.key',
      'management.key:/etc/qwen38-workload-manager/credentials/management.key',
    ]);
    expect(values(unit, 'Service', 'ExecStart')).toEqual([
      '/opt/qwen38-workload-manager/current/node-v22/bin/node /opt/qwen38-workload-manager/current/dist/managerd.js --manager-config /etc/qwen38-workload-manager/manager.production.json --models-config /etc/qwen38-workload-manager/models.production.json',
    ]);
  });

  it('kills the complete child cgroup and retains no model across restart', () => {
    expect(value(unit, 'Service', 'KillMode')).toBe('control-group');
    expect(value(unit, 'Service', 'KillSignal')).toBe('SIGTERM');
    expect(value(unit, 'Service', 'Restart')).toBe('on-failure');
    expect(value(unit, 'Service', 'ExecStartPre')).toBeUndefined();
    expect(unitText).not.toMatch(/--model(?:\s|=)|--load|--autoload|defaultModel/i);
  });

  it('applies the required sandbox and explicit read/write boundaries', () => {
    expect(value(unit, 'Service', 'NoNewPrivileges')).toBe('yes');
    expect(value(unit, 'Service', 'ProtectSystem')).toBe('strict');
    expect(value(unit, 'Service', 'ProtectHome')).toBe('read-only');
    expect(value(unit, 'Service', 'PrivateTmp')).toBe('yes');
    expect(value(unit, 'Service', 'UMask')).toBe('0077');
    expect(value(unit, 'Service', 'CapabilityBoundingSet')).toBe('');
    expect(value(unit, 'Service', 'RestrictAddressFamilies')).toBe('AF_UNIX AF_INET');
    expect(value(unit, 'Service', 'RemoveIPC')).toBe('yes');
    expect(value(unit, 'Service', 'ProtectKernelLogs')).toBe('yes');
    expect(value(unit, 'Service', 'ProtectProc')).toBe('invisible');
    expect(value(unit, 'Service', 'ProcSubset')).toBe('pid');
    expect(value(unit, 'Service', 'KeyringMode')).toBe('private');
    expect(value(unit, 'Service', 'DevicePolicy')).toBe('closed');
    expect(values(unit, 'Service', 'DeviceAllow')).toEqual([
      '/dev/dri/card1 rw',
      '/dev/dri/renderD128 rw',
    ]);
    expect(values(unit, 'Service', 'ReadOnlyPaths')).toEqual([
      '/opt/qwen38-workload-manager/current',
      '/etc/qwen38-workload-manager',
      '/home/agentops/apps/qwen38/build-vulkan',
      '/data/ai/models/llm/qwen3.8-27b',
    ]);
    expect(values(unit, 'Service', 'ReadWritePaths')).toEqual([
      '/run/qwen38-workload-manager',
      '/var/lib/qwen38-workload-manager',
      '/var/cache/qwen38-workload-manager',
      '/var/log/qwen38-workload-manager',
    ]);
  });

  it('contains no shell, inline secret, environment interpolation, or IPv6 wildcard', () => {
    const execStart = value(unit, 'Service', 'ExecStart') ?? '';
    expect(execStart).not.toMatch(/(?:\/bin\/(?:ba)?sh|\s-c(?:\s|$)|\$\(|`|[|;&])/);
    expect(values(unit, 'Service', 'Environment')).toEqual([]);
    expect(values(unit, 'Service', 'EnvironmentFile')).toEqual([]);
    expect(unitText).not.toMatch(/\[::\]|::\/0|AF_INET6|\$\{|\$\(|\b[0-9a-f]{64}\b|Bearer\s+[0-9a-f]/i);
    expect(values(unit, 'Service', 'IPAddressAllow')).toEqual(['localhost', '192.168.3.0/24']);
    expect(values(unit, 'Service', 'IPAddressDeny')).toEqual(['any']);
  });
});

type UnitSections = Record<string, Record<string, string[]>>;

function parseUnit(text: string): UnitSections {
  const sections: UnitSections = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)]$/.exec(line);
    if (header !== null) {
      section = header[1]!;
      sections[section] ??= {};
      continue;
    }
    const separator = line.indexOf('=');
    if (section === '' || separator < 1) throw new Error(`invalid_unit_line:${line}`);
    const key = line.slice(0, separator);
    const entry = line.slice(separator + 1);
    (sections[section]![key] ??= []).push(entry);
  }
  return sections;
}

function values(sections: UnitSections, section: string, key: string): string[] {
  return sections[section]?.[key] ?? [];
}

function value(sections: UnitSections, section: string, key: string): string | undefined {
  const entries = values(sections, section, key);
  if (entries.length > 1) throw new Error(`duplicate_unit_key:${section}.${key}`);
  return entries[0];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected_record');
  return value as Record<string, unknown>;
}
