import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

export interface OpenedSystemdCredentials {
  readonly inferenceKey: string;
  readonly managementKey: string;
  readonly inferenceFd: number;
  close(): void;
}

export function openSystemdCredentials(environment: Readonly<Record<string, string | undefined>> = process.env): OpenedSystemdCredentials {
  let inferenceFd: number | undefined;
  let managementFd: number | undefined;
  try {
    const directory = environment.CREDENTIALS_DIRECTORY;
    if (directory === undefined || !canonicalAbsolutePath(directory)) fail();
    const directoryStat = lstatSync(directory, { bigint: true });
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail();

    inferenceFd = openCredential(join(directory, 'inference.key'));
    managementFd = openCredential(join(directory, 'management.key'));
    const inferenceKey = readCredential(inferenceFd);
    const managementKey = readCredential(managementFd);
    if (inferenceKey.toLowerCase() === managementKey.toLowerCase()) fail();
    closeSync(managementFd);
    managementFd = undefined;

    let closed = false;
    const retainedFd = inferenceFd;
    inferenceFd = undefined;
    return Object.freeze({
      inferenceKey,
      managementKey,
      inferenceFd: retainedFd,
      close(): void {
        if (closed) return;
        closed = true;
        try { closeSync(retainedFd); } catch { /* idempotent close */ }
      },
    });
  } catch {
    if (inferenceFd !== undefined) try { closeSync(inferenceFd); } catch { /* best effort */ }
    if (managementFd !== undefined) try { closeSync(managementFd); } catch { /* best effort */ }
    throw new Error('invalid_systemd_credentials');
  }
}

function openCredential(path: string): number {
  const pathnameBefore = lstatSync(path, { bigint: true });
  if (!safeCredentialStat(pathnameBefore)) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptor = fstatSync(fd, { bigint: true });
    if (!safeCredentialStat(descriptor) || !sameIdentity(pathnameBefore, descriptor)) fail();
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readCredential(fd: number): string {
  const before = fstatSync(fd, { bigint: true });
  if (!safeCredentialStat(before) || (before.size !== 64n && before.size !== 65n)) fail();
  const contents = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < contents.length) {
    const count = readSync(fd, contents, offset, contents.length - offset, offset);
    if (count === 0) fail();
    offset += count;
  }
  const after = fstatSync(fd, { bigint: true });
  if (!sameIdentity(before, after)) fail();
  const text = contents.toString('utf8');
  if (!/^[0-9a-f]{64}\n?$/i.test(text)) fail();
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function safeCredentialStat(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && (Number(stat.mode) & 0o077) === 0;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function canonicalAbsolutePath(path: string): boolean {
  return path.length > 1 && !path.includes('\0') && isAbsolute(path) && normalize(path) === path;
}

function fail(): never { throw new Error('invalid_systemd_credentials'); }
