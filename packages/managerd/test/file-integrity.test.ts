import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  pinArtifact,
  revalidatePinnedArtifact,
  type ArtifactExpectation,
  type ArtifactIdentity,
  type GroupWritableAncestorException,
} from '../src/file-integrity.js';

const fixtures: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('pins exact bytes and SHA-256, then revalidates every cached identity field', async () => {
  const fixture = await makeFixture();
  const artifact = join(fixture, 'llama-server');
  await writeFile(artifact, 'known llama.cpp binary\n', { mode: 0o700 });
  const expected = await expectationFor(artifact);

  const pin = await pinArtifact(expected);

  expect(pin).toMatchObject({ version: 1, path: artifact, bytes: expected.bytes, sha256: expected.sha256 });
  expect(pin.file).toMatchObject({ path: artifact, uid: process.getuid?.(), gid: process.getgid?.(), mode: expect.any(Number) });
  expect(pin.file.dev).toMatch(/^\d+$/);
  expect(pin.file.inode).toMatch(/^\d+$/);
  expect(pin.file.mtimeNs).toMatch(/^\d+$/);
  expect(pin.file.ctimeNs).toMatch(/^\d+$/);
  expect(pin.file.size).toBe(String(expected.bytes));
  expect(pin.ancestors.at(-1)?.path).toBe(dirname(artifact));
  await expect(revalidatePinnedArtifact(expected, pin)).resolves.toBe(pin);
});

it('rejects missing paths, symlinks, and non-regular artifacts', async () => {
  const fixture = await makeFixture();
  const target = join(fixture, 'target.gguf');
  const link = join(fixture, 'link.gguf');
  const directory = join(fixture, 'directory.gguf');
  const fifo = join(fixture, 'fifo.gguf');
  await writeFile(target, 'model', { mode: 0o600 });
  await symlink(target, link);
  await mkdir(directory);
  await execFileAsync('mkfifo', [fifo]);
  const expected = await expectationFor(target);

  await expect(pinArtifact({ ...expected, path: join(fixture, 'missing.gguf') })).rejects.toThrow(/artifact_missing/);
  await expect(pinArtifact({ ...expected, path: link })).rejects.toThrow(/artifact_symlink/);
  await expect(pinArtifact({ ...expected, path: directory })).rejects.toThrow(/artifact_not_regular/);
  await expect(pinArtifact({ ...expected, path: fifo })).rejects.toThrow(/artifact_not_regular/);
});

it('rejects size, digest, and mutable artifact mode mismatches', async () => {
  const fixture = await makeFixture();
  const artifact = join(fixture, 'model.gguf');
  await writeFile(artifact, 'model bytes', { mode: 0o600 });
  const expected = await expectationFor(artifact);

  await expect(pinArtifact({ ...expected, bytes: expected.bytes + 1 })).rejects.toThrow(/artifact_size_mismatch/);
  await expect(pinArtifact({ ...expected, sha256: '0'.repeat(64) })).rejects.toThrow(/artifact_sha256_mismatch/);
  await chmod(artifact, 0o620);
  await expect(pinArtifact(expected)).rejects.toThrow(/artifact_group_or_world_writable/);
});

it('rejects group- and world-writable ancestors by default', async () => {
  const fixture = await makeFixture();
  const groupDirectory = join(fixture, 'group-catalog');
  const worldDirectory = join(fixture, 'world-catalog');
  await mkdirWithMode(groupDirectory, 0o770);
  await mkdirWithMode(worldDirectory, 0o777);
  const groupArtifact = join(groupDirectory, 'model.gguf');
  const worldArtifact = join(worldDirectory, 'model.gguf');
  await writeFile(groupArtifact, 'group model', { mode: 0o600 });
  await writeFile(worldArtifact, 'world model', { mode: 0o600 });

  await expect(pinArtifact(await expectationFor(groupArtifact))).rejects.toThrow(/unsafe_group_writable_ancestor/);
  await expect(pinArtifact(await expectationFor(worldArtifact))).rejects.toThrow(/unsafe_world_writable_ancestor/);
});

it('allows only a complete, live exception that pins every group-writable ancestor and current operator membership', async () => {
  const fixture = await makeFixture();
  const first = join(fixture, 'shared');
  const second = join(first, 'aiops');
  await mkdirWithMode(first, 0o770);
  await mkdirWithMode(second, 0o770);
  const artifact = join(second, 'model.gguf');
  await writeFile(artifact, 'exception model', { mode: 0o600 });
  const expected = await expectationFor(artifact);
  const exception = await groupWritableException([first, second]);

  const pin = await pinArtifact(expected, { groupWritableAncestorException: exception });
  await expect(revalidatePinnedArtifact(expected, pin, { groupWritableAncestorException: exception })).resolves.toBe(pin);

  const incomplete = { ...exception, ancestors: exception.ancestors.slice(1) };
  await expect(pinArtifact(expected, { groupWritableAncestorException: incomplete })).rejects.toThrow(/incomplete_group_writable_ancestor_exception/);

  const expired = { ...exception, expiresAt: new Date(Date.now() - 1_000).toISOString() };
  await expect(pinArtifact(expected, { groupWritableAncestorException: expired })).rejects.toThrow(/expired_group_writable_ancestor_exception/);

  const tooLong = { ...exception, expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1_000).toISOString() };
  await expect(pinArtifact(expected, { groupWritableAncestorException: tooLong })).rejects.toThrow(/group_writable_ancestor_exception_ttl_too_long/);

  const missingMembership = {
    ...exception,
    operatorGroupMembership: { ...exception.operatorGroupMembership, groupIds: [] },
  };
  await expect(pinArtifact(expected, { groupWritableAncestorException: missingMembership })).rejects.toThrow(/invalid_operator_group_membership_evidence/);

  const wrongRuntimeMembership = {
    ...exception,
    operatorGroupMembership: {
      ...exception.operatorGroupMembership,
      uid: exception.operatorGroupMembership.uid + 1,
    },
  };
  await expect(pinArtifact(expected, { groupWritableAncestorException: wrongRuntimeMembership })).rejects.toThrow(/invalid_operator_group_membership_evidence/);
});

it('never lets the group-writable exception cover world-writable ancestors or changed pinned identities', async () => {
  const fixture = await makeFixture();
  const shared = join(fixture, 'shared');
  await mkdirWithMode(shared, 0o770);
  const artifact = join(shared, 'model.gguf');
  await writeFile(artifact, 'model', { mode: 0o600 });
  const expected = await expectationFor(artifact);
  const exception = await groupWritableException([shared]);

  await chmod(shared, 0o777);
  await expect(pinArtifact(expected, { groupWritableAncestorException: exception })).rejects.toThrow(/unsafe_world_writable_ancestor/);

  await chmod(shared, 0o770);
  const changedIdentity = {
    ...exception,
    ancestors: [{ ...exception.ancestors[0]!, inode: String(BigInt(exception.ancestors[0]!.inode) + 1n) }],
  };
  await expect(pinArtifact(expected, { groupWritableAncestorException: changedIdentity })).rejects.toThrow(/group_writable_ancestor_identity_mismatch/);
});

it('fails closed when a cached artifact or ancestor identity changes before use', async () => {
  const fixture = await makeFixture();
  const catalog = join(fixture, 'catalog');
  await mkdirWithMode(catalog, 0o700);
  const artifact = join(catalog, 'model.gguf');
  await writeFile(artifact, 'original bytes', { mode: 0o600 });
  const expected = await expectationFor(artifact);
  const pin = await pinArtifact(expected);

  await writeFile(artifact, 'mutated!bytes', { mode: 0o600 });
  await expect(revalidatePinnedArtifact(expected, pin)).rejects.toThrow(/artifact_identity_changed/);

  await rm(artifact);
  const replacement = join(catalog, 'replacement.gguf');
  await writeFile(replacement, 'original bytes', { mode: 0o600 });
  await rename(replacement, artifact);
  await expect(revalidatePinnedArtifact(expected, pin)).rejects.toThrow(/artifact_identity_changed/);

  const freshExpectation = await expectationFor(artifact);
  const freshPin = await pinArtifact(freshExpectation);
  await chmod(catalog, 0o750);
  await expect(revalidatePinnedArtifact(freshExpectation, freshPin)).rejects.toThrow(/artifact_ancestor_identity_changed/);
});

it('rehashes an unissued or restored pin instead of trusting caller-supplied identities', async () => {
  const fixture = await makeFixture();
  const artifact = join(fixture, 'model.gguf');
  await writeFile(artifact, 'model', { mode: 0o600 });
  const expected = await expectationFor(artifact);
  const pin = await pinArtifact(expected);

  const restored = JSON.parse(JSON.stringify(pin)) as typeof pin;
  const reissued = await revalidatePinnedArtifact(expected, restored);
  expect(reissued).not.toBe(restored);
  await expect(revalidatePinnedArtifact(expected, reissued)).resolves.toBe(reissued);

  await writeFile(artifact, 'evil!', { mode: 0o600 });
  const forged = { ...pin, file: await identityFor(artifact) };
  await expect(revalidatePinnedArtifact(expected, forged)).rejects.toThrow(/artifact_sha256_mismatch/);
});

it('allows only root and the runtime uid by default, with any additional trusted owners explicit', async () => {
  const fixture = await makeFixture();
  const artifact = join(fixture, 'model.gguf');
  await writeFile(artifact, 'model', { mode: 0o600 });
  const expected = await expectationFor(artifact);
  const runtimeUid = process.getuid!();
  const unrelatedUid = runtimeUid === 4_294_967_294 ? 4_294_967_293 : 4_294_967_294;

  await expect(pinArtifact(expected, { trustedOwnerUids: [unrelatedUid] })).rejects.toThrow(/unsafe_ancestor_owner/);
  await expect(pinArtifact(expected, { trustedOwnerUids: [0, runtimeUid] })).resolves.toMatchObject({ path: artifact });
});

it('rejects malformed expectations and malformed persisted pins', async () => {
  const fixture = await makeFixture();
  const artifact = join(fixture, 'model.gguf');
  await writeFile(artifact, 'model', { mode: 0o600 });
  const expected = await expectationFor(artifact);
  const pin = await pinArtifact(expected);

  await expect(pinArtifact({ ...expected, path: 'relative.gguf' })).rejects.toThrow(/invalid_artifact_expectation/);
  await expect(pinArtifact({ ...expected, sha256: 'not-a-digest' })).rejects.toThrow(/invalid_artifact_expectation/);
  await expect(revalidatePinnedArtifact(expected, { ...pin, version: 2 } as never)).rejects.toThrow(/invalid_artifact_pin/);
  await expect(revalidatePinnedArtifact(expected, { ...pin, sha256: 'f'.repeat(64) })).rejects.toThrow(/artifact_pin_expectation_mismatch/);
});

it('interrupts artifact validation when its abort signal fires', async () => {
  const fixture = await makeFixture();
  const artifact = join(fixture, 'large.gguf');
  await writeFile(artifact, '', { mode: 0o600 });
  await truncate(artifact, 64 * 1024 * 1024);
  const controller = new AbortController();
  const validation = pinArtifact({ path: artifact, bytes: 64 * 1024 * 1024, sha256: '0'.repeat(64) }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);

  await expect(validation).rejects.toThrow(/artifact_validation_aborted/);
});

async function makeFixture(): Promise<string> {
  const path = await mkdtemp(join(homedir(), '.gwm-file-integrity-test-'));
  fixtures.push(path);
  await chmod(path, 0o700);
  return path;
}

async function mkdirWithMode(path: string, mode: number): Promise<void> {
  await mkdir(path, { mode });
  await chmod(path, mode);
}

async function expectationFor(path: string): Promise<ArtifactExpectation> {
  const value = await readFile(path);
  return Object.freeze({ path, bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') });
}

async function identityFor(path: string): Promise<ArtifactIdentity> {
  const stat = await lstat(path, { bigint: true });
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

async function groupWritableException(paths: readonly string[]): Promise<GroupWritableAncestorException> {
  const now = new Date();
  return Object.freeze({
    version: 1,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    operatorGroupMembership: Object.freeze({
      uid: process.getuid!(),
      primaryGid: process.getgid!(),
      groupIds: Object.freeze([...process.getgroups!()].sort((left, right) => left - right)),
      recordedAt: now.toISOString(),
    }),
    ancestors: Object.freeze(await Promise.all(paths.map(identityFor))),
  });
}
