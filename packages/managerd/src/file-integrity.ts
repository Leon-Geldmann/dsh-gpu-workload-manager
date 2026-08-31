import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, parse } from 'node:path';

export interface ArtifactExpectation {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** A JSON-safe snapshot of the kernel identity used for cache revalidation. */
export interface ArtifactIdentity {
  readonly path: string;
  readonly dev: string;
  readonly inode: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly size: string;
}

export interface ArtifactPin {
  readonly version: 1;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly file: ArtifactIdentity;
  /** Ordered from the filesystem root to the artifact's direct parent. */
  readonly ancestors: readonly ArtifactIdentity[];
}

export interface OperatorGroupMembershipEvidence {
  readonly uid: number;
  readonly primaryGid: number;
  readonly groupIds: readonly number[];
  readonly recordedAt: string;
}

/**
 * Temporary security-debt contract for a known group-writable hierarchy.
 * It cannot authorize world-writable paths or group/world-writable artifacts.
 */
export interface GroupWritableAncestorException {
  readonly version: 1;
  readonly expiresAt: string;
  readonly operatorGroupMembership: OperatorGroupMembershipEvidence;
  /** Exactly the unsafe ancestors, ordered from root toward the artifact. */
  readonly ancestors: readonly ArtifactIdentity[];
}

export interface ArtifactValidationOptions {
  readonly groupWritableAncestorException?: GroupWritableAncestorException;
  /** Defaults to root plus the current runtime uid. Extra owners must be explicit. */
  readonly trustedOwnerUids?: readonly number[];
  /** Allows long SHA-256 passes to stop promptly when their owning canary is terminated. */
  readonly signal?: AbortSignal;
}

export const MAX_GROUP_WRITABLE_EXCEPTION_TTL_MS = 24 * 60 * 60 * 1_000;

const IDENTITY_KEYS = Object.freeze([
  'path', 'dev', 'inode', 'uid', 'gid', 'mode', 'mtimeNs', 'ctimeNs', 'size',
] as const);
const PIN_KEYS = Object.freeze(['version', 'path', 'bytes', 'sha256', 'file', 'ancestors'] as const);
const EXCEPTION_KEYS = Object.freeze(['version', 'expiresAt', 'operatorGroupMembership', 'ancestors'] as const);
const MEMBERSHIP_KEYS = Object.freeze(['uid', 'primaryGid', 'groupIds', 'recordedAt'] as const);
const issuedPins = new WeakSet<object>();

export async function pinArtifact(
  expectation: ArtifactExpectation,
  options: ArtifactValidationOptions = {},
): Promise<ArtifactPin> {
  const expected = validateExpectation(expectation);
  const trustedOwners = validateOptions(options);
  throwIfAborted(options.signal);

  const ancestorsBefore = await captureAncestors(expected.path);
  throwIfAborted(options.signal);
  rejectUntrustedAncestorOwners(ancestorsBefore, trustedOwners);
  validateAncestorPolicy(ancestorsBefore, options.groupWritableAncestorException, Date.now());
  const pathnameBefore = await captureArtifactPath(expected.path);
  throwIfAborted(options.signal);
  rejectUntrustedArtifactOwner(pathnameBefore, trustedOwners);
  rejectWritableArtifact(pathnameBefore);

  const handle = await openNoFollow(expected.path);
  try {
    const fileBeforeStat = await handle.stat({ bigint: true });
    requireRegularFileStat(fileBeforeStat);
    const fileBefore = identityFromStat(expected.path, fileBeforeStat);
    if (!sameIdentity(pathnameBefore, fileBefore)) throw new Error('artifact_changed_during_validation');
    rejectUntrustedArtifactOwner(fileBefore, trustedOwners);
    rejectWritableArtifact(fileBefore);
    if (fileBefore.size !== String(expected.bytes)) throw new Error('artifact_size_mismatch');

    const digest = await sha256Handle(handle, expected.bytes, options.signal);
    throwIfAborted(options.signal);
    const fileAfter = identityFromStat(expected.path, await handle.stat({ bigint: true }));
    if (!sameIdentity(fileBefore, fileAfter)) throw new Error('artifact_changed_during_validation');

    const pathnameAfter = await captureArtifactPath(expected.path);
    if (!sameIdentity(fileAfter, pathnameAfter)) throw new Error('artifact_changed_during_validation');
    const ancestorsAfter = await captureAncestors(expected.path);
    throwIfAborted(options.signal);
    if (!sameIdentityList(ancestorsBefore, ancestorsAfter)) throw new Error('artifact_ancestor_changed_during_validation');
    rejectUntrustedAncestorOwners(ancestorsAfter, trustedOwners);
    validateAncestorPolicy(ancestorsAfter, options.groupWritableAncestorException, Date.now());

    if (digest !== expected.sha256) throw new Error('artifact_sha256_mismatch');
    const pin = freezePin({
      version: 1,
      path: expected.path,
      bytes: expected.bytes,
      sha256: expected.sha256,
      file: fileAfter,
      ancestors: ancestorsAfter,
    });
    issuedPins.add(pin);
    return pin;
  } finally {
    await handle.close();
  }
}

/**
 * Uses the identity-only fast path solely for deeply frozen pins issued by this
 * module instance. A restored or caller-built cache entry is rehashed and
 * reissued; every trusted expectation and live identity mismatch fails closed.
 */
export async function revalidatePinnedArtifact(
  expectation: ArtifactExpectation,
  value: ArtifactPin,
  options: ArtifactValidationOptions = {},
): Promise<ArtifactPin> {
  const expected = validateExpectation(expectation);
  const pin = validatePin(value);
  if (pin.path !== expected.path || pin.bytes !== expected.bytes || pin.sha256 !== expected.sha256) {
    throw new Error('artifact_pin_expectation_mismatch');
  }
  const trustedOwners = validateOptions(options);
  throwIfAborted(options.signal);

  // Deserialized or caller-constructed pins are only cache hints. They have no
  // in-process provenance, so establish a new pin with a full SHA-256 pass.
  if (!issuedPins.has(value)) return pinArtifact(expected, options);

  const ancestorsBefore = await captureAncestors(pin.path);
  throwIfAborted(options.signal);
  rejectUntrustedAncestorOwners(ancestorsBefore, trustedOwners);
  validateAncestorPolicy(ancestorsBefore, options.groupWritableAncestorException, Date.now());

  const pathnameBefore = await captureArtifactPath(pin.path);
  if (!sameIdentity(pin.file, pathnameBefore)) throw new Error('artifact_identity_changed');
  rejectUntrustedArtifactOwner(pathnameBefore, trustedOwners);
  rejectWritableArtifact(pathnameBefore);

  const handle = await openNoFollow(pin.path);
  try {
    const fileBeforeStat = await handle.stat({ bigint: true });
    requireRegularFileStat(fileBeforeStat);
    const fileBefore = identityFromStat(pin.path, fileBeforeStat);
    if (!sameIdentity(pin.file, fileBefore)) throw new Error('artifact_identity_changed');
    rejectUntrustedArtifactOwner(fileBefore, trustedOwners);

    const fileAfter = identityFromStat(pin.path, await handle.stat({ bigint: true }));
    if (!sameIdentity(fileBefore, fileAfter)) throw new Error('artifact_identity_changed');
    const pathnameAfter = await captureArtifactPath(pin.path);
    if (!sameIdentity(fileAfter, pathnameAfter)) throw new Error('artifact_identity_changed');

    if (!sameIdentityList(pin.ancestors, ancestorsBefore)) throw new Error('artifact_ancestor_identity_changed');
    const ancestorsAfter = await captureAncestors(pin.path);
    throwIfAborted(options.signal);
    if (!sameIdentityList(pin.ancestors, ancestorsAfter)) throw new Error('artifact_ancestor_identity_changed');
    rejectUntrustedAncestorOwners(ancestorsAfter, trustedOwners);
    validateAncestorPolicy(ancestorsAfter, options.groupWritableAncestorException, Date.now());
    return value;
  } finally {
    await handle.close();
  }
}

function validateExpectation(value: ArtifactExpectation): ArtifactExpectation {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['path', 'bytes', 'sha256'])
    || typeof value.path !== 'string'
    || value.path.length <= 1
    || !isCanonicalAbsolutePath(value.path)
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 0
    || typeof value.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error('invalid_artifact_expectation');
  }
  return Object.freeze({ path: value.path, bytes: value.bytes, sha256: value.sha256 });
}

function validatePin(value: ArtifactPin): ArtifactPin {
  if (!isRecord(value)
    || !hasOnlyKeys(value, PIN_KEYS)
    || value.version !== 1
    || !Array.isArray(value.ancestors)) throw new Error('invalid_artifact_pin');

  let expected: ArtifactExpectation;
  let file: ArtifactIdentity;
  let ancestors: ArtifactIdentity[];
  try {
    expected = validateExpectation({ path: value.path, bytes: value.bytes, sha256: value.sha256 });
    file = validateIdentity(value.file);
    ancestors = value.ancestors.map(validateIdentity);
  } catch {
    throw new Error('invalid_artifact_pin');
  }
  if (file.path !== expected.path || file.size !== String(expected.bytes)) throw new Error('invalid_artifact_pin');
  const expectedAncestorPaths = ancestorPaths(expected.path);
  if (ancestors.length !== expectedAncestorPaths.length
    || ancestors.some((identity, index) => identity.path !== expectedAncestorPaths[index])) {
    throw new Error('invalid_artifact_pin');
  }
  return freezePin({ version: 1, ...expected, file, ancestors });
}

function validateOptions(value: ArtifactValidationOptions): ReadonlySet<number> {
  if (!isRecord(value)
    || Object.keys(value).some((key) => key !== 'groupWritableAncestorException' && key !== 'trustedOwnerUids' && key !== 'signal')
    || value.signal !== undefined && !(value.signal instanceof AbortSignal)) {
    throw new Error('invalid_artifact_validation_options');
  }
  const configured = value.trustedOwnerUids;
  if (configured === undefined) {
    if (process.getuid === undefined) throw new Error('trusted_owner_identity_unavailable');
    return new Set([0, process.getuid()]);
  }
  if (!Array.isArray(configured)
    || configured.length === 0
    || configured.some((uid) => !validId(uid))
    || new Set(configured).size !== configured.length) {
    throw new Error('invalid_trusted_owner_uids');
  }
  return new Set(configured);
}

async function captureArtifactPath(path: string): Promise<ArtifactIdentity> {
  let stat: BigIntStats;
  try {
    stat = await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') throw new Error('artifact_missing');
    throw new Error('artifact_path_inspection_failed');
  }
  if (stat.isSymbolicLink()) throw new Error('artifact_symlink');
  if (!stat.isFile()) throw new Error('artifact_not_regular');
  return identityFromStat(path, stat);
}

async function captureAncestors(path: string): Promise<ArtifactIdentity[]> {
  const identities: ArtifactIdentity[] = [];
  for (const ancestor of ancestorPaths(path)) {
    let stat: BigIntStats;
    try {
      stat = await lstat(ancestor, { bigint: true });
    } catch {
      throw new Error('artifact_ancestor_inspection_failed');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('artifact_ancestor_not_directory');
    identities.push(identityFromStat(ancestor, stat));
  }
  return identities;
}

function ancestorPaths(path: string): string[] {
  const root = parse(path).root;
  const paths: string[] = [];
  let current = dirname(path);
  while (true) {
    paths.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) throw new Error('invalid_artifact_expectation');
    current = parent;
  }
  return paths.reverse();
}

function validateAncestorPolicy(
  ancestors: readonly ArtifactIdentity[],
  exception: GroupWritableAncestorException | undefined,
  now: number,
): void {
  const worldWritable = ancestors.filter((identity) => (identity.mode & 0o002) !== 0);
  if (worldWritable.length > 0) throw new Error('unsafe_world_writable_ancestor');
  const groupWritable = ancestors.filter((identity) => (identity.mode & 0o020) !== 0);

  if (exception === undefined) {
    if (groupWritable.length > 0) throw new Error('unsafe_group_writable_ancestor');
    return;
  }
  const parsed = validateGroupWritableException(exception, now);
  if (groupWritable.length === 0
    || parsed.ancestors.length !== groupWritable.length
    || groupWritable.some((identity, index) => identity.path !== parsed.ancestors[index]?.path)) {
    throw new Error('incomplete_group_writable_ancestor_exception');
  }
  for (let index = 0; index < groupWritable.length; index += 1) {
    if (!sameIdentity(groupWritable[index]!, parsed.ancestors[index]!)) {
      throw new Error('group_writable_ancestor_identity_mismatch');
    }
  }
  const groups = new Set(parsed.operatorGroupMembership.groupIds);
  if (groupWritable.some((identity) => !groups.has(identity.gid))) {
    throw new Error('invalid_operator_group_membership_evidence');
  }
}

function validateGroupWritableException(value: GroupWritableAncestorException, now: number): GroupWritableAncestorException {
  if (!isRecord(value)
    || !hasOnlyKeys(value, EXCEPTION_KEYS)
    || value.version !== 1
    || typeof value.expiresAt !== 'string'
    || !Array.isArray(value.ancestors)
    || !isRecord(value.operatorGroupMembership)) {
    throw new Error('invalid_group_writable_ancestor_exception');
  }
  const expiresAt = parseTimestamp(value.expiresAt);
  if (expiresAt <= now) throw new Error('expired_group_writable_ancestor_exception');

  const membership = value.operatorGroupMembership;
  if (!hasOnlyKeys(membership, MEMBERSHIP_KEYS)
    || !validId(membership.uid)
    || !validId(membership.primaryGid)
    || !Array.isArray(membership.groupIds)
    || membership.groupIds.length === 0
    || membership.groupIds.some((group) => !validId(group))
    || new Set(membership.groupIds).size !== membership.groupIds.length
    || typeof membership.recordedAt !== 'string') {
    throw new Error('invalid_operator_group_membership_evidence');
  }
  const recordedAt = parseTimestamp(membership.recordedAt, 'invalid_operator_group_membership_evidence');
  if (recordedAt > now || recordedAt >= expiresAt) throw new Error('invalid_operator_group_membership_evidence');
  if (expiresAt - recordedAt > MAX_GROUP_WRITABLE_EXCEPTION_TTL_MS) {
    throw new Error('group_writable_ancestor_exception_ttl_too_long');
  }

  if (process.getuid === undefined || process.getgid === undefined || process.getgroups === undefined) {
    throw new Error('invalid_operator_group_membership_evidence');
  }
  const runtimeGroups = [...new Set(process.getgroups())].sort((left, right) => left - right);
  const recordedGroups = [...membership.groupIds].sort((left, right) => left - right);
  if (membership.uid !== process.getuid()
    || membership.primaryGid !== process.getgid()
    || runtimeGroups.length !== recordedGroups.length
    || runtimeGroups.some((group, index) => group !== recordedGroups[index])) {
    throw new Error('invalid_operator_group_membership_evidence');
  }

  let ancestors: ArtifactIdentity[];
  try {
    ancestors = value.ancestors.map(validateIdentity);
  } catch {
    throw new Error('invalid_group_writable_ancestor_exception');
  }
  if (ancestors.length === 0 || new Set(ancestors.map((identity) => identity.path)).size !== ancestors.length) {
    throw new Error('incomplete_group_writable_ancestor_exception');
  }
  return Object.freeze({
    version: 1,
    expiresAt: value.expiresAt,
    operatorGroupMembership: Object.freeze({
      uid: membership.uid,
      primaryGid: membership.primaryGid,
      groupIds: Object.freeze(recordedGroups),
      recordedAt: membership.recordedAt,
    }),
    ancestors: Object.freeze(ancestors),
  });
}

async function openNoFollow(path: string): Promise<FileHandle> {
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
    throw new Error('no_follow_open_unavailable');
  }
  try {
    // O_NONBLOCK prevents an lstat/open swap to a FIFO from hanging managerd.
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === 'ELOOP') throw new Error('artifact_symlink');
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') throw new Error('artifact_missing');
    throw new Error('artifact_open_failed');
  }
}

async function sha256Handle(handle: FileHandle, expectedBytes: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    throwIfAborted(signal);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > expectedBytes) throw new Error('artifact_size_mismatch');
    hash.update(buffer.subarray(0, bytesRead));
  }
  if (position !== expectedBytes) throw new Error('artifact_size_mismatch');
  return hash.digest('hex');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('artifact_validation_aborted');
}

function requireRegularFileStat(stat: BigIntStats): void {
  if (!stat.isFile()) throw new Error('artifact_not_regular');
}

function rejectWritableArtifact(identity: ArtifactIdentity): void {
  if ((identity.mode & 0o022) !== 0) throw new Error('artifact_group_or_world_writable');
}

function rejectUntrustedArtifactOwner(identity: ArtifactIdentity, trustedOwners: ReadonlySet<number>): void {
  if (!trustedOwners.has(identity.uid)) throw new Error('unsafe_artifact_owner');
}

function rejectUntrustedAncestorOwners(
  identities: readonly ArtifactIdentity[],
  trustedOwners: ReadonlySet<number>,
): void {
  if (identities.some((identity) => !trustedOwners.has(identity.uid))) throw new Error('unsafe_ancestor_owner');
}

function identityFromStat(path: string, stat: BigIntStats): ArtifactIdentity {
  return Object.freeze({
    path,
    dev: String(stat.dev),
    inode: String(stat.ino),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    size: String(stat.size),
  });
}

function validateIdentity(value: unknown): ArtifactIdentity {
  if (!isRecord(value)
    || !hasOnlyKeys(value, IDENTITY_KEYS)
    || typeof value.path !== 'string'
    || !isCanonicalAbsolutePath(value.path)
    || !decimal(value.dev)
    || !decimal(value.inode)
    || !validId(value.uid)
    || !validId(value.gid)
    || !validMode(value.mode)
    || !decimal(value.mtimeNs)
    || !decimal(value.ctimeNs)
    || !decimal(value.size)) throw new Error('invalid_artifact_identity');
  return Object.freeze({
    path: value.path,
    dev: value.dev,
    inode: value.inode,
    uid: value.uid,
    gid: value.gid,
    mode: value.mode,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
    size: value.size,
  });
}

function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function sameIdentityList(left: readonly ArtifactIdentity[], right: readonly ArtifactIdentity[]): boolean {
  return left.length === right.length && left.every((identity, index) => sameIdentity(identity, right[index]!));
}

function freezePin(value: ArtifactPin): ArtifactPin {
  return Object.freeze({
    version: 1,
    path: value.path,
    bytes: value.bytes,
    sha256: value.sha256,
    file: Object.freeze({ ...value.file }),
    ancestors: Object.freeze(value.ancestors.map((identity) => Object.freeze({ ...identity }))),
  });
}

function isCanonicalAbsolutePath(path: string): boolean {
  return path.length > 0 && !path.includes('\0') && isAbsolute(path) && normalize(path) === path;
}

function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validMode(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseTimestamp(value: string, code = 'invalid_group_writable_ancestor_exception'): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new Error(code);
  return timestamp;
}

function errorCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === 'string' ? value.code : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
