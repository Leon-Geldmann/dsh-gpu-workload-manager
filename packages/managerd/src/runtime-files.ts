import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import type { RuntimeArguments } from './production-runtime.js';
import { parseProductionCatalog, parseProductionManagerConfig, type ProductionCatalogConfig, type ProductionManagerConfig } from './runtime-config.js';

const MAX_CONFIG_BYTES = 1024 * 1024;

export interface ProductionConfiguration {
  readonly manager: ProductionManagerConfig;
  readonly catalog: ProductionCatalogConfig;
}

export function loadProductionConfiguration(arguments_: RuntimeArguments): ProductionConfiguration {
  try {
    const manager = parseProductionManagerConfig(readRootOwnedJson(arguments_.managerConfigPath));
    if (manager.catalogPath !== arguments_.modelsConfigPath) throw new Error('catalog_path_mismatch');
    const catalog = parseProductionCatalog(readRootOwnedJson(arguments_.modelsConfigPath));
    return Object.freeze({ manager, catalog });
  } catch {
    throw new Error('invalid_runtime_configuration');
  }
}

function readRootOwnedJson(path: string): unknown {
  const pathname = lstatSync(path, { bigint: true });
  if (!safeConfig(pathname)) throw new Error('unsafe_runtime_config');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!safeConfig(before) || !sameIdentity(pathname, before) || before.size < 2n || before.size > BigInt(MAX_CONFIG_BYTES)) throw new Error('unsafe_runtime_config');
    const body = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < body.length) {
      const count = readSync(fd, body, offset, body.length - offset, offset);
      if (count === 0) throw new Error('truncated_runtime_config');
      offset += count;
    }
    if (!sameIdentity(before, fstatSync(fd, { bigint: true }))) throw new Error('changed_runtime_config');
    return JSON.parse(body.toString('utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}

function safeConfig(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0n && (Number(stat.mode) & 0o022) === 0;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
