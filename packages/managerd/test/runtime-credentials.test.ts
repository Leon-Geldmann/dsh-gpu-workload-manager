import { fstatSync } from 'node:fs';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSystemdCredentials } from '../src/runtime-credentials.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

it('reads separate systemd credentials and leaves only the inference descriptor open at offset zero', async () => {
  const directory = await credentialDirectory('a'.repeat(64), 'b'.repeat(64));
  const credentials = openSystemdCredentials({ CREDENTIALS_DIRECTORY: directory });
  expect(credentials.inferenceKey).toBe('a'.repeat(64));
  expect(credentials.managementKey).toBe('b'.repeat(64));
  expect(fstatSync(credentials.inferenceFd).isFile()).toBe(true);

  const probe = Buffer.alloc(1);
  const bytes = (await import('node:fs')).readSync(credentials.inferenceFd, probe, 0, 1, null);
  expect(bytes).toBe(1);
  expect(probe.toString()).toBe('a');

  credentials.close();
  credentials.close();
  expect(() => fstatSync(credentials.inferenceFd)).toThrow();
});

it.each([
  ['missing directory', {}],
  ['relative directory', { CREDENTIALS_DIRECTORY: 'credentials' }],
])('rejects a %s without disclosing credential material', (_label, environment) => {
  expect(() => openSystemdCredentials(environment)).toThrowError(/^invalid_systemd_credentials$/);
});

it('rejects identical inference and management credentials', async () => {
  const directory = await credentialDirectory('c'.repeat(64), 'c'.repeat(64));
  expect(() => openSystemdCredentials({ CREDENTIALS_DIRECTORY: directory })).toThrowError(/^invalid_systemd_credentials$/);
});

it('rejects permissive, malformed, and symlink credentials', async () => {
  const weak = await credentialDirectory('d'.repeat(64), 'e'.repeat(64));
  await chmod(join(weak, 'management.key'), 0o644);
  expect(() => openSystemdCredentials({ CREDENTIALS_DIRECTORY: weak })).toThrowError(/^invalid_systemd_credentials$/);

  const malformed = await credentialDirectory(`${'f'.repeat(64)}\nextra`, '1'.repeat(64));
  expect(() => openSystemdCredentials({ CREDENTIALS_DIRECTORY: malformed })).toThrowError(/^invalid_systemd_credentials$/);

  const linked = await credentialDirectory('2'.repeat(64), '3'.repeat(64));
  const target = join(linked, 'target.key');
  await writeFile(target, '4'.repeat(64), { mode: 0o600 });
  await rm(join(linked, 'inference.key'));
  await symlink(target, join(linked, 'inference.key'));
  expect(() => openSystemdCredentials({ CREDENTIALS_DIRECTORY: linked })).toThrowError(/^invalid_systemd_credentials$/);
});

async function credentialDirectory(inferenceKey: string, managementKey: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'managerd-credentials-'));
  directories.push(directory);
  await writeFile(join(directory, 'inference.key'), inferenceKey, { mode: 0o600 });
  await writeFile(join(directory, 'management.key'), managementKey, { mode: 0o600 });
  return directory;
}
