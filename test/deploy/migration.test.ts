import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repository = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const preflightPath = join(repository, 'deploy/scripts/preflight-ubuntu.sh');
const installPath = join(repository, 'deploy/scripts/install-ubuntu.sh');
const rollbackPath = join(repository, 'deploy/scripts/rollback-ubuntu.sh');
const sandboxes: string[] = [];

afterEach(async () => {
  for (const path of sandboxes) {
    try { execFileSync('chmod', ['-R', 'u+w', path]); } catch { /* best-effort fixture cleanup */ }
  }
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.sequential('Ubuntu migration transaction', () => {
  it('keeps preflight read-only and fails closed without a fresh agentops maintenance marker', async () => {
    const fixture = await makeFixture();
    const before = await treeFingerprint(fixture.root, ['state']);

    const passed = run(preflightPath, fixture);
    expect(passed.status, passed.output).toBe(0);
    expect(passed.output).toContain('preflight-ubuntu: PASS');
    expect(await treeFingerprint(fixture.root, ['state'])).toEqual(before);

    await rm(target(fixture.root, '/home/agentops/.config/ai-stack/qwen38-maintenance-window'));
    const rejected = run(preflightPath, fixture);
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain('maintenance_window_not_proven');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('rejects equal credential values case-insensitively before any canary or old-service stop', async () => {
    const fixture = await makeFixture();
    await writeFile(
      target(fixture.root, '/etc/qwen38-workload-manager/credentials/inference.key'),
      `${'A'.repeat(64)}\n`,
    );
    await writeFile(
      target(fixture.root, '/etc/qwen38-workload-manager/credentials/management.key'),
      `${'a'.repeat(64)}\n`,
    );

    const result = run(preflightPath, fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('credentials_not_distinct');
    expect(await optionalRead(join(fixture.state, 'events.log'))).toBe('');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('rejects credential bytes outside exact 64hex plus optional one LF before downtime', async () => {
    const fixture = await makeFixture();
    await writeFile(
      target(fixture.root, '/etc/qwen38-workload-manager/credentials/inference.key'),
      `${'b'.repeat(64)}\n\n`,
    );

    const result = run(preflightPath, fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('inference_credential_invalid_content');
    expect(await optionalRead(join(fixture.state, 'events.log'))).toBe('');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('defaults to a true dry-run with no canary, service, or filesystem mutation', async () => {
    const fixture = await makeFixture();
    const before = await treeFingerprint(fixture.root, ['state']);

    const result = run(installPath, fixture);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('dry-run PASS; no changes made');
    expect(await treeFingerprint(fixture.root, ['state'])).toEqual(before);
    expect(await optionalRead(join(fixture.state, 'events.log'))).toBe('');
    expect(await optionalRead(join(fixture.state, 'canary.log'))).toBe('');
  });

  it('rejects a group-writable release root even when every manifest entry is safe', async () => {
    const fixture = await makeFixture();
    await chmod(fixture.release, 0o770);

    const result = run(preflightPath, fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('release_root_group_or_world_writable');
  });

  it('rejects an empty release directory that is not represented by a manifest payload', async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.release, 'config/unlisted-empty'), { mode: 0o700 });

    const result = run(preflightPath, fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('release_manifest_unpinned_directory');
  });

  it('rejects a manifest-valid release that omits its root-stage live verifier', async () => {
    const fixture = await makeFixture();
    await rm(join(fixture.release, 'verify'), { recursive: true });
    const releaseId = await writeReleaseManifest(fixture.release);

    const result = run(preflightPath, { ...fixture, releaseId });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('missing_release_entry');
  });

  it('runs a live-safe fake canary, quiesces the old model, then runs the real canary and installs exact permissions', async () => {
    const fixture = await makeFixture();
    const inferenceBefore = await readFile(target(fixture.root, '/etc/qwen38-workload-manager/credentials/inference.key'));
    const managementBefore = await readFile(target(fixture.root, '/etc/qwen38-workload-manager/credentials/management.key'));
    const oldUnitBefore = await readFile(target(fixture.root, '/home/agentops/.config/systemd/user/qwen38.service'));
    const oldConfigBefore = await readFile(target(fixture.root, '/home/agentops/apps/qwen38/config/models.json'));
    const modelSentinel = target(fixture.root, '/data/ai/models/llm/DO-NOT-DELETE.gguf');
    const cacheSentinel = target(fixture.root, '/var/cache/qwen38-workload-manager/DO-NOT-DELETE.cache');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('install-ubuntu: PASS');
    expect((await readFile(join(fixture.state, 'events.log'), 'utf8')).trim().split('\n')).toEqual([
      'canary fake 127.0.0.1 18081',
      'canary artifact-only',
      'old stop',
      'old disable',
      'canary real 127.0.0.1 18082',
      'new daemon-reload',
      'new enable',
      'new start',
    ]);
    expect(await readFile(join(fixture.state, 'canary.log'), 'utf8')).toBe(
      'fake:127.0.0.1:18081\nartifact-only\nreal:127.0.0.1:18082\n',
    );

    const release = target(fixture.root, `/opt/qwen38-workload-manager/releases/${fixture.releaseId}`);
    expect(await readlink(target(fixture.root, '/opt/qwen38-workload-manager/current'))).toBe(release);
    expect((await stat(join(release, 'node-v22/bin/node'))).mode & 0o777).toBe(0o550);
    expect((await stat(join(release, 'dist/managerd.js'))).mode & 0o777).toBe(0o440);
    expect((await stat(join(release, 'verify/verify-live.sh'))).mode & 0o777).toBe(0o440);
    expect((await stat(join(release, 'verify/preflight-ubuntu.sh'))).mode & 0o777).toBe(0o550);
    expect(await readFile(join(release, 'verify/verify-live.sh'))).toEqual(
      await readFile(join(repository, 'deploy/scripts/verify-live.sh')),
    );
    expect((await stat(target(fixture.root, '/etc/qwen38-workload-manager/manager.production.json'))).mode & 0o777).toBe(0o644);
    expect((await stat(target(fixture.root, '/etc/qwen38-workload-manager/models.production.json'))).mode & 0o777).toBe(0o644);
    expect((await stat(target(fixture.root, '/etc/systemd/system/qwen38-workload-manager.service'))).mode & 0o777).toBe(0o644);
    expect((await stat(target(fixture.root, '/etc/qwen38-workload-manager/credentials/inference.key'))).mode & 0o777).toBe(0o600);
    expect((await stat(target(fixture.root, '/etc/qwen38-workload-manager/credentials/management.key'))).mode & 0o777).toBe(0o600);

    expect(await readFile(target(fixture.root, '/etc/qwen38-workload-manager/credentials/inference.key'))).toEqual(inferenceBefore);
    expect(await readFile(target(fixture.root, '/etc/qwen38-workload-manager/credentials/management.key'))).toEqual(managementBefore);
    expect(await readFile(target(fixture.root, '/home/agentops/.config/systemd/user/qwen38.service'))).toEqual(oldUnitBefore);
    expect(await readFile(target(fixture.root, '/home/agentops/apps/qwen38/config/models.json'))).toEqual(oldConfigBefore);
    expect(await readFile(modelSentinel, 'utf8')).toBe('model-preserved\n');
    expect(await readFile(cacheSentinel, 'utf8')).toBe('cache-preserved\n');
    await expect(lstat(target(fixture.root, '/home/agentops/.config/ai-stack/qwen38-maintenance-window'))).rejects.toThrow();

    const snapshots = (await readdir(target(fixture.root, '/var/lib/qwen38-workload-manager-migrations')))
      .filter((name) => name.endsWith('.snapshot'));
    expect(snapshots).toHaveLength(1);
    const snapshot = await readFile(target(fixture.root, `/var/lib/qwen38-workload-manager-migrations/${snapshots[0]}`), 'utf8');
    expect(snapshot).toMatch(/^version=3$/m);
    expect(snapshot).toMatch(/^new_service_stage=start_attempted$/m);
    expect(snapshot).toMatch(/^cleanup_stage=not_started$/m);
    expect(snapshot).toMatch(/^old_active=active$/m);
    expect(snapshot).toMatch(/^old_main_pid=4242$/m);
    expect(snapshot).toMatch(/^old_control_group=\/user\.slice\/user-1001\.slice\/user@1001\.service\/app\.slice\/qwen38\.service$/m);
    expect(snapshot).toMatch(/^old_unit_sha256=[0-9a-f]{64}$/m);
    expect(snapshot).toMatch(/^old_config_sha256=[0-9a-f]{64}$/m);
    expect(snapshot).not.toContain('OLD UNIT CONTENT');
    expect(snapshot).not.toContain('OLD CONFIG CONTENT');
    expect(snapshot).not.toContain('inference-secret');
    expect(snapshot).not.toContain('management-secret');
  });

  it('does not stop the old router when the fake canary fails', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-fake-canary'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect((await optionalRead(join(fixture.state, 'events.log'))).trim().split('\n').filter(Boolean)).toEqual([
      'canary fake 127.0.0.1 18081',
    ]);
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    await expect(lstat(target(fixture.root, '/etc/systemd/system/qwen38-workload-manager.service'))).rejects.toThrow();
  });

  it('runs the strict artifact-only gate before downtime and leaves the old router untouched on failure', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-artifact-canary'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('artifact_integrity_preflight_failed');
    expect((await optionalRead(join(fixture.state, 'events.log'))).trim().split('\n').filter(Boolean)).toEqual([
      'canary fake 127.0.0.1 18081',
      'canary artifact-only',
    ]);
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect(await readFile(join(fixture.state, 'old-enabled'), 'utf8')).toBe('enabled\n');
  });

  it('restores the old router when the real canary fails in the quiesced maintenance window', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-real-canary'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('real_canary_failed');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect((await readFile(join(fixture.state, 'events.log'), 'utf8')).trim().split('\n')).toEqual([
      'canary fake 127.0.0.1 18081',
      'canary artifact-only',
      'old stop',
      'old disable',
      'canary real 127.0.0.1 18082',
      'old enable',
      'old start',
      'new daemon-reload',
    ]);
  });

  it('bounds and retries rollback bootstrap inspection after the old router is stopped', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-real-canary'), '1\n');
    await writeFile(join(fixture.state, 'hang-once-rollback-bootstrap-stat'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status).not.toBe(124);
    expect(result.output).toContain('real_canary_failed');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  }, 12_000);

  it('does not restart the old model when failed real-canary quiescence is unproven', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-real-canary'), '1\n');
    await writeFile(join(fixture.state, 'residual-real-canary'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('real_canary_failed');
    expect(result.output).toContain('automatic rollback BLOCKED reason=canary_quiescence_unproven');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('inactive\n');
    expect(await optionalRead(join(fixture.state, 'events.log'))).not.toContain('old start');
  });

  it('bounds a blocking real-canary cgroup inspection before refusing automatic rollback', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-real-canary'), '1\n');
    await writeFile(join(fixture.state, 'exercise-canary-quiescence'), '1\n');
    await rm(join(fixture.state, 'canary-cgroup-pids'));
    execFileSync('mkfifo', [join(fixture.state, 'canary-cgroup-pids')]);

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status).not.toBe(124);
    expect(result.output).toContain('real_canary_failed');
    expect(result.output).toContain('automatic rollback BLOCKED reason=canary_quiescence_unproven');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('inactive\n');
  }, 12_000);

  it('pins credential metadata across untrusted canary execution without reading or copying key bytes', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'mutate-credential'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('credential_changed_during_canary');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect(await optionalRead(join(fixture.state, 'events.log'))).toContain('old stop');
  });

  it('fails closed when a post-stop credential stat emits valid metadata then fails', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'partial-failed-credential-stat-after-old-stop'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('credential_changed_during_canary');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('executes both canaries from one root-controlled verified copy even if the source release changes', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'mutate-source-canary'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status, result.output).toBe(0);
    expect(await readFile(join(fixture.state, 'canary.log'), 'utf8')).toBe(
      'fake:127.0.0.1:18081\nartifact-only\nreal:127.0.0.1:18082\n',
    );
    expect(await optionalRead(join(fixture.state, 'mutated-canary.log'))).toBe('');
  });

  it('installs config and unit bytes from the verified copy after the source release is replaced', async () => {
    const fixture = await makeFixture();
    const managerBefore = await readFile(join(fixture.release, 'config/manager.production.json'));
    const unitBefore = await readFile(join(fixture.release, 'systemd/qwen38-workload-manager.service'));
    await writeFile(join(fixture.state, 'mutate-source-config'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status, result.output).toBe(0);
    expect(await readFile(target(fixture.root, '/etc/qwen38-workload-manager/manager.production.json'))).toEqual(managerBefore);
    expect(await readFile(target(fixture.root, '/etc/systemd/system/qwen38-workload-manager.service'))).toEqual(unitBefore);
    expect(await readFile(join(fixture.release, 'config/manager.production.json'), 'utf8')).toBe('{"mutated":true}\n');
  });

  it('restores the old service if 8080 remains occupied after the stop', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'keep-port-busy'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('port_8080_not_free_after_old_stop');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect((await readFile(join(fixture.state, 'events.log'), 'utf8')).trim().split('\n')).toEqual([
      'canary fake 127.0.0.1 18081',
      'canary artifact-only',
      'old stop',
      'old disable',
      'old enable',
      'old start',
      'new daemon-reload',
    ]);
  });

  it('blocks the real canary and restores the old router when its cgroup or GPU owner remains', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'keep-old-child'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('old_router_not_quiesced');
    expect(result.output).toContain('automatic rollback completed');
    expect(await optionalRead(join(fixture.state, 'canary.log'))).toBe('fake:127.0.0.1:18081\nartifact-only\n');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('bounds a blocking old-router cgroup after stop and restores the old router', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fifo-old-cgroup-after-stop'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 10);

    expect(result.status).not.toBe(124);
    expect(result.output).toContain('old_router_not_quiesced');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  }, 15_000);

  it('does not let an unrelated agentops zombie permanently block old-runtime quiescence', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'use-production-process-scan'), '1\n');
    await secureFile(join(fixture.state, 'proc/6001/stat'), '6001 (unrelated worker) Z 1 1 1 0 -1 0\n', 0o400);
    await symlink('/definitely/missing/zombie-executable', join(fixture.state, 'proc/6001/exe'));

    const script = await readFile(installPath, 'utf8');
    expect(script).toContain('process_state=${process_stat_tail%% *}');
    const result = run(installPath, fixture, ['--apply']);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('install-ubuntu: PASS');
  });

  it('fails closed for an extant non-zombie agentops process whose executable is unreadable', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'use-production-process-scan'), '1\n');
    await secureFile(join(fixture.state, 'proc/6002/stat'), '6002 (unreadable worker) S 1 1 1 0 -1 0\n', 0o400);
    await symlink('/definitely/missing/live-executable', join(fixture.state, 'proc/6002/exe'));

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('old_router_not_quiesced');
    expect(result.output).toContain('automatic rollback completed');
    expect(await optionalRead(join(fixture.state, 'canary.log'))).toBe('fake:127.0.0.1:18081\nartifact-only\n');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('automatically removes only the new transaction artifacts and restores the old service on activation failure', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-new-start'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    await expect(lstat(target(fixture.root, '/etc/systemd/system/qwen38-workload-manager.service'))).rejects.toThrow();
    await expect(lstat(target(fixture.root, '/etc/qwen38-workload-manager/manager.production.json'))).rejects.toThrow();
    await expect(lstat(target(fixture.root, '/opt/qwen38-workload-manager/current'))).rejects.toThrow();
    await expect(lstat(target(fixture.root, `/opt/qwen38-workload-manager/releases/${fixture.releaseId}`))).rejects.toThrow();
    expect(await readFile(target(fixture.root, '/data/ai/models/llm/DO-NOT-DELETE.gguf'), 'utf8')).toBe('model-preserved\n');
    expect(await readFile(target(fixture.root, '/var/cache/qwen38-workload-manager/DO-NOT-DELETE.cache'), 'utf8')).toBe('cache-preserved\n');
  });

  it('restores the old user service when the system manager fails before first activation', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-new-system-manager'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('new_service_activation_failed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect(await readFile(join(fixture.state, 'old-enabled'), 'utf8')).toBe('enabled\n');
    expect(await readFile(join(fixture.state, 'new-active'), 'utf8')).toBe('inactive\n');
  });

  it.each([
    ['before a new-service start', 'fail-new-daemon-reload-once'],
    ['after a successful new-service stop', 'fail-new-start'],
  ])('retries one transient listener-inspection failure %s before restoring the old service', async (_phase, failureFlag) => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, failureFlag), '1\n');
    await writeFile(join(fixture.state, 'fail-first-new-absence-ss'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('automatic rollback completed');
    expect(result.output).not.toContain('automatic rollback FAILED');
    expect(Number.parseInt(await readFile(join(fixture.state, 'new-absence-ss-count'), 'utf8'), 10)).toBeGreaterThanOrEqual(2);
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('fails closed when enable creates its link and the system manager becomes unavailable before queued work can be cancelled', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'hang-new-enable-after-effect'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('new_service_activation_failed');
    expect(result.output).toContain('automatic rollback FAILED');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('inactive\n');
    expect(await readFile(join(fixture.state, 'old-enabled'), 'utf8')).toBe('disabled\n');
    await expect(lstat(target(fixture.root, '/etc/systemd/system/multi-user.target.wants/qwen38-workload-manager.service'))).resolves.toBeDefined();
  });

  it('stops a new runtime that appears after the enable effect before restoring the old service', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-new-enable-after-runtime-effect'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('new_service_activation_failed');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect(await readFile(join(fixture.state, 'new-active'), 'utf8')).toBe('inactive\n');
  });

  it('bounds a hung new-service start and completes automatic rollback', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'hang-new-start'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('new_service_activation_failed');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect(await readFile(join(fixture.state, 'old-enabled'), 'utf8')).toBe('enabled\n');
    expect(await readFile(join(fixture.state, 'new-start-args'), 'utf8')).toContain('start qwen38-workload-manager.service');
  });

  it('restores the old user service when disable removes its link before the system manager hangs', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-new-readiness'), '1\n');
    await writeFile(join(fixture.state, 'hang-new-disable-system-manager-after-effect'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('new_service_readiness_failed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect(await readFile(join(fixture.state, 'old-enabled'), 'utf8')).toBe('enabled\n');
    await expect(lstat(target(fixture.root, '/etc/systemd/system/multi-user.target.wants/qwen38-workload-manager.service'))).rejects.toThrow();
  }, 10_000);

  it('does not restore the old model while a queued new-service start cannot be cancelled', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'queue-new-start-job'), '1\n');
    await writeFile(join(fixture.state, 'hang-new-stop-before-cancel'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('new_service_readiness_failed');
    expect(result.output).toContain('automatic rollback FAILED');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('inactive\n');
    expect(await readFile(join(fixture.state, 'new-job'), 'utf8')).toBe('start\n');
    expect(await optionalRead(join(fixture.state, 'events.log'))).not.toContain('old start');
  });

  it.each([
    ['stop', 'hang-old-stop-after-effect'],
    ['disable', 'hang-old-disable-after-effect'],
  ])('bounds a hung old-service %s after its state change and completes cutover', async (_operation, flag) => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, flag), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('install-ubuntu: PASS');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('inactive\n');
    expect(await readFile(join(fixture.state, 'old-enabled'), 'utf8')).toBe('disabled\n');
    expect(await readFile(join(fixture.state, 'new-active'), 'utf8')).toBe('active\n');
  });

  it('waits for a slow old-service stop to reach terminal state within the quiesce deadline', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'delay-old-stop'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('install-ubuntu: PASS');
    expect(Number.parseInt(await readFile(join(fixture.state, 'old-stop-show-count'), 'utf8'), 10)).toBeGreaterThanOrEqual(3);
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('inactive\n');
  });

  it.each([
    ['post-stop canary listener inspection', 'hang-canary-port-ss-after-old-stop'],
    ['post-stop firewall inspection', 'hang-ufw-after-old-stop'],
    ['post-stop release-only integrity revalidation', 'hang-next-sha256sum-after-old-stop'],
  ])('bounds a hung %s and automatically restores the old service', async (_boundary, flag) => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, flag), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect(await readFile(join(fixture.state, 'old-enabled'), 'utf8')).toBe('enabled\n');
  });

  it('restores the old service before attempting failed-staging cleanup', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-real-canary'), '1\n');
    await writeFile(join(fixture.state, 'hang-staging-cleanup-sha-after-old-stop'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('waits for the synchronous systemd start job before inspecting readiness', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'queued-new-start'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('install-ubuntu: PASS');
    expect(await readFile(join(fixture.state, 'new-start-args'), 'utf8')).not.toContain('--no-block');
  });

  it('waits beyond the former 30-poll readiness limit for a valid new service startup', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'delay-new-readiness'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('install-ubuntu: PASS');
    expect(Number.parseInt(await readFile(join(fixture.state, 'new-start-show-count'), 'utf8'), 10)).toBeGreaterThan(30);
  });

  it.each([
    ['failed', 'terminal-new-failed'],
    ['not-found', 'terminal-new-not-found'],
    ['auto-restart after failure', 'terminal-new-auto-restart'],
    ['malformed successful systemctl output', 'terminal-new-malformed-output'],
    ['unexpected active cgroup', 'terminal-new-wrong-cgroup'],
  ])('fails after one readiness inspection when the new unit enters terminal %s state', async (_state, flag) => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, flag), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('new_service_readiness_failed');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'new-start-show-count'), 'utf8')).toBe('1\n');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('fails closed and restores the old router when post-start readiness cannot prove the new listener', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-new-readiness'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('new_service_readiness_failed');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect(await readFile(join(fixture.state, 'old-enabled'), 'utf8')).toBe('enabled\n');
  });

  it('restores the old router when the new UNLOADED service cgroup contains a child', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'keep-new-child'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('new_service_readiness_failed');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('bounds a blocking new-service cgroup readiness read and retries successfully', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'hang-new-cgroup-readiness-once'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('install-ubuntu: PASS');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('inactive\n');
  }, 12_000);

  it('bounds an unreadable new-service cgroup before deciding whether old service restore is safe', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'fail-new-readiness'), '1\n');
    await writeFile(join(fixture.state, 'fifo-new-cgroup-on-stop'), '1\n');

    const result = runBounded(installPath, fixture, ['--apply'], 8);

    expect(result.status).not.toBe(124);
    expect(result.output).toContain('new_service_readiness_failed');
    expect(result.output).toContain('automatic rollback FAILED');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('inactive\n');
  }, 12_000);

  it('restores the old router when more than one process owns the new 8080 listener', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'duplicate-new-listener'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('new_service_readiness_failed');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it.each([
    ['fail-new-show-after-output', 'systemctl'],
    ['fail-new-ss-after-output', 'gateway listener inspection'],
    ['fail-child-ss', 'child listener inspection'],
  ])('does not accept partial or failed %s output while proving new readiness', async (flag) => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, flag), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('new_service_readiness_failed');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('performs an explicit rollback under the migration lock and proves the old router is healthy', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));

    const result = runRaw(rollbackPath, [
      '--snapshot', join(migrationDirectory, snapshotName!), '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('rollback-ubuntu: PASS old=active');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect(await readFile(join(fixture.state, 'old-enabled'), 'utf8')).toBe('enabled\n');
    await expect(lstat(target(fixture.root, `/opt/qwen38-workload-manager/releases/${fixture.releaseId}`))).rejects.toThrow();
    const syncs = (await readFile(join(fixture.state, 'sync.log'), 'utf8')).trim().split('\n');
    const manifestFile = syncs.findIndex((line) => line.includes('.cleanup-manifest.tmp'));
    const snapshotWrites = syncs
      .map((line, index) => line.includes('.cleanup-stage.tmp') ? index : -1)
      .filter((index) => index >= 0);
    const deletedParents = syncs.findIndex((line) => line.endsWith('/opt/qwen38-workload-manager'));
    expect(manifestFile).toBeGreaterThanOrEqual(0);
    expect(snapshotWrites).toHaveLength(2);
    expect(snapshotWrites[0]).toBeGreaterThan(manifestFile);
    expect(deletedParents).toBeGreaterThan(snapshotWrites[0]!);
    expect(snapshotWrites[1]).toBeGreaterThan(deletedParents);
  });

  it('starts a fresh old-identity deadline after slow explicit artifact validation', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    await writeFile(join(fixture.state, 'delay-explicit-release-verification'), '1\n');

    const result = runRaw(rollbackPath, [
      '--snapshot', join(migrationDirectory, snapshotName!), '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('rollback-ubuntu: PASS old=active');
  }, 10_000);

  it('bounds a hung full release verification before explicit rollback mutation', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    await writeFile(join(fixture.state, 'hang-explicit-release-verification'), '1\n');

    const result = runRaw('/usr/bin/timeout', [
      '--signal=KILL', '8s', rollbackPath,
      '--snapshot', join(migrationDirectory, snapshotName!), '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(result.status).toBe(1);
    expect(result.output).toContain('new_artifact_identity_changed');
    expect(await readFile(join(fixture.state, 'new-active'), 'utf8')).toBe('active\n');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('inactive\n');
  }, 12_000);

  it('resumes exact release cleanup after a bounded mid-delete interruption', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    const snapshot = join(migrationDirectory, snapshotName!);
    await writeFile(join(fixture.state, 'hang-release-unlink-after-effect'), '1\n');

    const interrupted = runRaw(rollbackPath, [
      '--snapshot', snapshot, '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(interrupted.status).not.toBe(0);
    expect(interrupted.output).toContain('new_artifact_cleanup_failed');
    expect(await readFile(snapshot, 'utf8')).toMatch(/^cleanup_stage=started$/m);
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');

    const resumed = runRaw(rollbackPath, [
      '--snapshot', snapshot, '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(resumed.status, resumed.output).toBe(0);
    expect(resumed.output).toContain('rollback-ubuntu: PASS old=active');
    expect(await readFile(snapshot, 'utf8')).toMatch(/^cleanup_stage=complete$/m);
    await expect(lstat(target(fixture.root, `/opt/qwen38-workload-manager/releases/${fixture.releaseId}`))).rejects.toThrow();
  }, 12_000);

  it('resumes release cleanup after a leaf directory was removed before interruption', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    const snapshot = join(migrationDirectory, snapshotName!);
    await writeFile(join(fixture.state, 'hang-release-rmdir-after-effect'), '1\n');

    const interrupted = runRaw(rollbackPath, [
      '--snapshot', snapshot, '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(interrupted.status).not.toBe(0);
    expect(interrupted.output).toContain('new_artifact_cleanup_failed');
    expect(await readFile(snapshot, 'utf8')).toMatch(/^cleanup_stage=started$/m);

    const resumed = runRaw(rollbackPath, [
      '--snapshot', snapshot, '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(resumed.status, resumed.output).toBe(0);
    expect(await readFile(snapshot, 'utf8')).toMatch(/^cleanup_stage=complete$/m);
    await expect(lstat(target(fixture.root, `/opt/qwen38-workload-manager/releases/${fixture.releaseId}`))).rejects.toThrow();
  }, 12_000);

  it('bounds rollback service mutations that hang after taking effect and restores the old router', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    await writeFile(join(fixture.state, 'hang-rollback-mutations-after-effect'), '1\n');

    const result = runRaw('/usr/bin/timeout', [
      '--signal=KILL', '12s', rollbackPath,
      '--snapshot', join(migrationDirectory, snapshotName!), '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('rollback-ubuntu: PASS old=active');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect(await readFile(join(fixture.state, 'old-enabled'), 'utf8')).toBe('enabled\n');
    expect(await readFile(join(fixture.state, 'new-active'), 'utf8')).toBe('inactive\n');
  }, 15_000);

  it('bounds a hung final daemon-reload after the old router is restored', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    await writeFile(join(fixture.state, 'hang-final-daemon-reload'), '1\n');

    const result = runRaw('/usr/bin/timeout', [
      '--signal=KILL', '8s', rollbackPath,
      '--snapshot', join(migrationDirectory, snapshotName!), '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('new_service_reload_failed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
    expect(await readFile(join(fixture.state, 'old-enabled'), 'utf8')).toBe('enabled\n');
  });

  it('waits for a slowly loading old model before declaring rollback healthy', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    await writeFile(join(fixture.state, 'delay-old-start'), '1\n');

    const result = runRaw(rollbackPath, [
      '--snapshot', join(migrationDirectory, snapshotName!), '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(result.status, result.output).toBe(0);
    expect(Number.parseInt(await readFile(join(fixture.state, 'old-start-show-count'), 'utf8'), 10)).toBeGreaterThanOrEqual(3);
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('rejects multiple reuse-port listeners while proving rollback readiness', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    await writeFile(join(fixture.state, 'duplicate-old-listener'), '1\n');

    const result = runRaw(rollbackPath, [
      '--snapshot', join(migrationDirectory, snapshotName!), '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('old_router_restore_unprovable');
  });

  it('fails rollback if the old boot-time enablement state is not restored', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    await writeFile(join(fixture.state, 'fail-old-enable-state'), '1\n');

    const result = runRaw(rollbackPath, [
      '--snapshot', join(migrationDirectory, snapshotName!), '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('old_router_restore_unprovable');
  });

  it('fails fast when the old unit enters failed during rollback', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    await writeFile(join(fixture.state, 'fail-old-start'), '1\n');

    const result = runRaw(rollbackPath, [
      '--snapshot', join(migrationDirectory, snapshotName!), '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('old_router_restore_failed');
  });

  it.each([
    ['fail-old-ss-after-output', 'listener'],
    ['fail-props-after-output', 'protected endpoint'],
  ])('does not report rollback success from partial failed %s output', async (flag) => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    await writeFile(join(fixture.state, flag), '1\n');

    const result = runRaw(rollbackPath, [
      '--snapshot', join(migrationDirectory, snapshotName!), '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('old_router_restore_unprovable');
    expect(result.output).not.toContain('rollback-ubuntu: PASS');
  });

  it('makes explicit rollback fail closed if old unit/config identity changed after the snapshot', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    const snapshot = join(migrationDirectory, snapshotName!);
    await writeFile(target(fixture.root, '/home/agentops/apps/qwen38/config/models.json'), 'tampered\n');

    const result = runRaw(rollbackPath, ['--snapshot', snapshot, '--fixture-root', fixture.root], fixture.env);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('old_config_identity_changed');
    expect(await readFile(join(fixture.state, 'new-active'), 'utf8')).toBe('active\n');
    expect(await lstat(target(fixture.root, '/etc/systemd/system/qwen38-workload-manager.service'))).toBeDefined();
  });

  it('refuses to delete an installed release tree containing a file not pinned by its manifest', async () => {
    const fixture = await makeFixture();
    const installed = run(installPath, fixture, ['--apply']);
    expect(installed.status, installed.output).toBe(0);
    const migrationDirectory = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const [snapshotName] = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.snapshot'));
    const release = target(fixture.root, `/opt/qwen38-workload-manager/releases/${fixture.releaseId}`);
    await chmod(join(release, 'dist'), 0o750);
    await secureFile(join(release, 'dist/operator-note'), 'must-not-delete\n', 0o600);
    await chmod(join(release, 'dist'), 0o550);

    const result = runRaw(rollbackPath, [
      '--snapshot', join(migrationDirectory, snapshotName!), '--fixture-root', fixture.root, '--apply',
    ], fixture.env);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('new_artifact_identity_changed');
    expect(await readFile(join(release, 'dist/operator-note'), 'utf8')).toBe('must-not-delete\n');
    expect(await readFile(join(fixture.state, 'new-active'), 'utf8')).toBe('active\n');
  });

  it('rejects an unsafe firewall boundary before any canary or mutation', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'unsafe-ufw'), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('trusted_lan_boundary_not_proven');
    expect(await optionalRead(join(fixture.state, 'events.log'))).toBe('');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('rejects a firewall line that smuggles a broader source beside the trusted CIDR', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'smuggled-ufw'), '1\n');

    const result = run(preflightPath, fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('trusted_lan_boundary_not_proven');
  });

  it.each([
    ['default-allow-ufw', 'default allow incoming'],
    ['range-ufw', 'a broad port range'],
    ['unsafe-raw-ufw', 'a broader effective raw rule'],
    ['custom-chain-ufw', 'a broad rule in a custom chain reachable from INPUT'],
    ['ipv6-ufw', 'an IPv6 rule that exposes the gateway port'],
    ['raw-input-policy-accept', 'an effective INPUT policy that contradicts verbose default deny'],
    ['missing-trusted-raw-rule', 'the raw rules never allow the trusted subnet to port 8080'],
    ['preceding-raw-drop', 'a terminal raw DROP makes the later trusted allow unreachable'],
    ['summary-deny-before-allow', 'an earlier summary DENY blocks the later trusted allow'],
  ])('rejects %s because %s does not prove the LAN boundary', async (flag) => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, flag), '1\n');

    const result = run(preflightPath, fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('trusted_lan_boundary_not_proven');
  });

  it.each([
    ['save-missing-exact', 'omits the exact trusted NEW TCP/8080 accept'],
    ['save-preceding-drop', 'drops trusted TCP/8080 before the exact accept'],
    ['save-broad-accept', 'also accepts TCP/8080 from an untrusted IPv4 source'],
    ['save-ipv6-accept', 'accepts TCP/8080 through an IPv6 INPUT path'],
    ['save-input-policy-accept', 'declares a non-DROP INPUT policy'],
    ['save-custom-chain-broad-accept', 'reaches a broad accept through a custom chain'],
    ['save-malformed-rule', 'contains a malformed ordered rule'],
    ['save-duplicate-input-chain', 'declares INPUT more than once'],
    ['save-duplicate-exact', 'contains a duplicate exact accept'],
    ['save-unsupported-ambiguity', 'uses an unsupported match that can divert trusted traffic'],
    ['save-negated-source-accept', 'accepts an untrusted source through a negated source match'],
    ['save-negated-interface-accept', 'accepts non-loopback traffic through a negated interface match'],
    ['save-negated-port-accept', 'accepts 8080 through a negated different-port match'],
    ['save-broad-untracked-accept', 'accepts untrusted TCP/8080 marked UNTRACKED'],
  ])('rejects an iptables-save snapshot that %s (%s)', async (flag) => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, flag), '1\n');

    const result = run(preflightPath, fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('trusted_lan_boundary_not_proven');
  });

  it.each([
    ['fail-iptables-save-after-output', 'IPv4'],
    ['fail-ip6tables-save-after-output', 'IPv6'],
  ])('rejects partial %s filter output when the save command fails', async (flag) => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, flag), '1\n');

    const result = run(preflightPath, fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('trusted_lan_boundary_not_proven');
  });

  it.each([
    ['fail-iptables-save-after-output-after-old-stop', 'IPv4'],
    ['fail-ip6tables-save-after-output-after-old-stop', 'IPv6'],
  ])('rolls back when the post-stop %s save command emits partial output and fails', async (flag) => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, flag), '1\n');

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('trusted_lan_boundary_not_proven');
    expect(result.output).toContain('automatic rollback completed');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('refuses migration when the old active listener ownership cannot be proven', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'old-active'), 'inactive\n');
    await writeFile(join(fixture.state, 'old-pid'), '0\n');
    await writeFile(join(fixture.state, 'port8080'), '0\n');

    const result = run(preflightPath, fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('old_router_state_unprovable');
  });

  it('does not confuse a specific IPv4 address ending in 0.0.0.0 with the wildcard listener', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.state, 'specific-old-listener'), '1\n');

    const result = run(preflightPath, fixture);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('old_router_listener_unprovable');
    expect(await optionalRead(join(fixture.state, 'events.log'))).toBe('');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('never follows a pre-existing migration lock symlink', async () => {
    const fixture = await makeFixture();
    const migrations = target(fixture.root, '/var/lib/qwen38-workload-manager-migrations');
    const victim = join(fixture.root, 'lock-victim');
    await mkdir(migrations, { recursive: true, mode: 0o700 });
    await chmod(migrations, 0o700);
    await secureFile(victim, 'must-not-truncate\n', 0o600);
    await symlink(victim, join(migrations, 'install.lock'));

    const result = run(installPath, fixture, ['--apply']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('unsafe_migration_lock');
    expect(await readFile(victim, 'utf8')).toBe('must-not-truncate\n');
    expect(await readFile(join(fixture.state, 'old-active'), 'utf8')).toBe('active\n');
  });

  it('contains static guardrails against secret copying and broad data deletion', async () => {
    const scripts = await Promise.all([preflightPath, installPath, rollbackPath].map((path) => readFile(path, 'utf8')));
    const combined = scripts.join('\n');
    const runCanary = /run_canary\(\) \{([\s\S]*?)\n\}\n\nrun_artifact_gate/.exec(scripts[1])?.[1] ?? '';
    const artifactGate = /run_artifact_gate\(\) \{([\s\S]*?)\n\}\n\nverify_new_service/.exec(scripts[1])?.[1] ?? '';

    expect(combined).not.toMatch(/rm\s+(?:-[A-Za-z]*r[A-Za-z]*f?|-[A-Za-z]*f[A-Za-z]*r)\b/);
    expect(combined).not.toMatch(/(?:cat|cp|mv|install)\s+[^\n]*(?:inference\.key|management\.key)/);
    expect(combined).not.toMatch(/(?:GGUF|\.gguf|\/data\/ai\/cache)/i);
    expect(combined).not.toMatch(/(?:echo|printf)\s+[^\n]*(?:KEY|TOKEN|SECRET|CREDENTIALS_DIRECTORY)/i);
    expect(await readFile(installPath, 'utf8')).toMatch(/APPLY=0/);
    expect(combined).toContain('/var/lib/qwen38-workload-manager-migrations');
    expect(combined).not.toMatch(/MIGRATIONS=.*\/var\/lib\/qwen38-workload-manager\/migrations/);
    expect(await readFile(installPath, 'utf8')).toMatch(/systemd-run/);
    expect(await readFile(installPath, 'utf8')).toMatch(/User=agentops/);
    expect(await readFile(installPath, 'utf8')).toMatch(/LoadCredential=inference\.key:/);
    expect(await readFile(installPath, 'utf8')).toMatch(/LoadCredential=management\.key:/);
    expect(await readFile(installPath, 'utf8')).toMatch(/StandardOutput=null/);
    expect(await readFile(installPath, 'utf8')).toMatch(/RuntimeMaxSec=/);
    expect(runCanary).toContain('"$TIMEOUT" --signal=TERM --kill-after=15s "$watchdog" "${command[@]}"');
    expect(runCanary).toContain('prove_canary_quiesced');
    expect(await readFile(installPath, 'utf8')).toMatch(/ProtectSystem=strict/);
    expect(await readFile(installPath, 'utf8')).not.toContain('! -s "$cgroup_file"');
    expect(await readFile(installPath, 'utf8')).not.toContain('! -s "$GWM_FAKE_STATE/old-cgroup-pids"');
    expect(await readFile(installPath, 'utf8')).toMatch(/QWEN38_CANARY_MODE=artifact-only/);
    expect(artifactGate).toContain('--property=User=agentops');
    expect(artifactGate).toContain('--property=RestrictAddressFamilies=AF_UNIX');
    expect(artifactGate).toContain('UnsetEnvironment=QWEN38_CANARY_HOST QWEN38_CANARY_PORT QWEN38_CANARY_CHILD_PORT CREDENTIALS_DIRECTORY');
    expect(artifactGate).not.toContain('LoadCredential=');
    expect(artifactGate).not.toContain('DeviceAllow=');
    expect(artifactGate).not.toContain('AF_INET');
    expect(artifactGate).not.toContain('--setenv=QWEN38_CANARY_HOST');
    expect(artifactGate).not.toContain('--setenv=QWEN38_CANARY_PORT');
    expect(artifactGate).not.toContain('--setenv=QWEN38_CANARY_CHILD_PORT');
    const rollbackSource = await readFile(rollbackPath, 'utf8');
    expect(rollbackSource).toContain('OLD_RESTORE_TIMEOUT_SECONDS=1800');
    expect(rollbackSource).toContain('OLD_RESTORE_DEADLINE=$((SECONDS + OLD_RESTORE_TIMEOUT_SECONDS))');
    expect(await readFile(rollbackPath, 'utf8')).not.toMatch(/find[^\n]*-delete/);
  });
});

interface Fixture {
  readonly root: string;
  readonly release: string;
  readonly releaseId: string;
  readonly state: string;
  readonly env: NodeJS.ProcessEnv;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'gwm-migration-fixture.'));
  sandboxes.push(root);
  const state = join(root, 'state');
  const bin = join(root, 'fake-bin');
  const release = join(root, 'release-staging');
  await Promise.all([mkdir(state), mkdir(bin), mkdir(release)]);
  await secureFile(join(root, '.qwen38-workload-manager-fixture-v1'), 'qwen38-workload-manager-fixture-v1\n', 0o600);

  await secureFile(target(root, '/home/agentops/.config/systemd/user/qwen38.service'), 'OLD UNIT CONTENT\n', 0o640);
  await secureFile(target(root, '/home/agentops/apps/qwen38/config/models.json'), 'OLD CONFIG CONTENT\n', 0o660);
  const marker = target(root, '/home/agentops/.config/ai-stack/qwen38-maintenance-window');
  await secureFile(marker, 'qwen38-maintenance-window-v1\n', 0o600);
  const now = new Date();
  await utimes(marker, now, now);

  await mkdir(target(root, '/etc/qwen38-workload-manager/credentials'), { recursive: true, mode: 0o700 });
  await mkdir(target(root, '/etc/systemd/system'), { recursive: true, mode: 0o755 });
  await chmod(target(root, '/etc/qwen38-workload-manager'), 0o755);
  await chmod(target(root, '/etc/qwen38-workload-manager/credentials'), 0o700);
  await chmod(target(root, '/etc/systemd/system'), 0o755);
  await secureFile(target(root, '/etc/qwen38-workload-manager/credentials/inference.key'), `${'b'.repeat(64)}\n`, 0o600);
  await secureFile(target(root, '/etc/qwen38-workload-manager/credentials/management.key'), `${'a'.repeat(64)}\n`, 0o600);
  await secureFile(target(root, '/data/ai/models/llm/DO-NOT-DELETE.gguf'), 'model-preserved\n', 0o600);
  await secureFile(target(root, '/var/cache/qwen38-workload-manager/DO-NOT-DELETE.cache'), 'cache-preserved\n', 0o600);

  await Promise.all([
    secureFile(join(state, 'old-active'), 'active\n', 0o600),
    secureFile(join(state, 'old-enabled'), 'enabled\n', 0o600),
    secureFile(join(state, 'old-pid'), '4242\n', 0o600),
    secureFile(join(state, 'old-cgroup-pids'), '4242\n4343\n', 0o600),
    secureFile(join(state, 'old-job'), '', 0o600),
    secureFile(join(state, 'old-stop-show-count'), '0\n', 0o600),
    secureFile(join(state, 'old-gpu-owner'), '1\n', 0o600),
    secureFile(join(state, 'port8080'), '1\n', 0o600),
    secureFile(join(state, 'new-active'), 'inactive\n', 0o600),
    secureFile(join(state, 'new-enabled'), 'disabled\n', 0o600),
    secureFile(join(state, 'new-pid'), '0\n', 0o600),
    secureFile(join(state, 'new-cgroup-pids'), '', 0o600),
    secureFile(join(state, 'new-job'), '', 0o600),
    secureFile(join(state, 'new-phase'), 'UNLOADED\n', 0o600),
    secureFile(join(state, 'canary-cgroup-pids'), '', 0o600),
    secureFile(join(state, 'new-start-show-count'), '0\n', 0o600),
    secureFile(join(state, 'new-absence-ss-count'), '0\n', 0o600),
    secureFile(join(state, 'new-daemon-reload-count'), '0\n', 0o600),
    secureFile(join(state, 'old-start-show-count'), '0\n', 0o600),
  ]);

  await executable(join(bin, 'systemctl'), fakeSystemctl);
  await executable(join(bin, 'ss'), fakeSs);
  await executable(join(bin, 'ufw'), fakeUfw);
  await executable(join(bin, 'iptables-save'), fakeIptablesSave);
  await executable(join(bin, 'ip6tables-save'), fakeIptablesSave);
  await executable(join(bin, 'curl'), fakeCurl);
  await executable(join(bin, 'sha256sum'), fakeSha256sum);
  await executable(join(bin, 'stat'), fakeStat);
  await executable(join(bin, 'unlink'), fakeUnlink);
  await executable(join(bin, 'rmdir'), fakeRmdir);
  await executable(join(bin, 'cat'), fakeCat);
  await executable(join(bin, 'sync'), fakeSync);

  await executable(join(release, 'node-v22/bin/node'), '#!/bin/sh\nexit 0\n');
  await secureFile(join(release, 'dist/canary.js'), 'export {};\n', 0o600);
  await secureFile(join(release, 'dist/managerd.js'), 'export {};\n', 0o600);
  await secureFile(join(release, 'dist/package.json'), '{"type":"commonjs"}\n', 0o600);
  await executable(join(release, 'canary/fake-canary'), fakeCanary);
  await executable(join(release, 'canary/real-canary'), fakeCanary);
  await mkdir(join(release, 'config'), { recursive: true });
  await mkdir(join(release, 'systemd'), { recursive: true });
  await mkdir(join(release, 'verify'), { recursive: true });
  await copyFile(join(repository, 'deploy/config/manager.production.json'), join(release, 'config/manager.production.json'));
  await copyFile(join(repository, 'deploy/config/models.production.json'), join(release, 'config/models.production.json'));
  await copyFile(join(repository, 'deploy/systemd/qwen38-workload-manager.service'), join(release, 'systemd/qwen38-workload-manager.service'));
  await copyFile(join(repository, 'deploy/scripts/preflight-ubuntu.sh'), join(release, 'verify/preflight-ubuntu.sh'));
  await copyFile(join(repository, 'deploy/scripts/verify-live.sh'), join(release, 'verify/verify-live.sh'));
  await Promise.all([
    chmod(join(release, 'config/manager.production.json'), 0o600),
    chmod(join(release, 'config/models.production.json'), 0o600),
    chmod(join(release, 'systemd/qwen38-workload-manager.service'), 0o600),
    chmod(join(release, 'verify/verify-live.sh'), 0o600),
    chmod(join(release, 'verify/preflight-ubuntu.sh'), 0o700),
  ]);
  const releaseId = await writeReleaseManifest(release);
  const releaseDirectories = execFileSync('find', ['.', '-type', 'd', '-print'], { cwd: release, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  await Promise.all(releaseDirectories.map((path) => chmod(join(release, path), 0o700)));

  return {
    root,
    release,
    releaseId,
    state,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      GWM_FAKE_STATE: state,
      GWM_FIXTURE_ROOT: root,
      GWM_RELEASE_SOURCE: release,
    },
  };
}

function run(path: string, fixture: Fixture, extra: string[] = []) {
  return runRaw(path, [
    '--release-dir', fixture.release,
    '--release-id', fixture.releaseId,
    '--fixture-root', fixture.root,
    ...extra,
  ], fixture.env);
}

function runBounded(path: string, fixture: Fixture, extra: string[], seconds: number) {
  return runRaw('/usr/bin/timeout', [
    '--signal=KILL', `${seconds}s`, path,
    '--release-dir', fixture.release,
    '--release-id', fixture.releaseId,
    '--fixture-root', fixture.root,
    ...extra,
  ], fixture.env);
}

function runRaw(path: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(path, args, { env, encoding: 'utf8' });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`,
  };
}

async function secureFile(path: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
}

async function executable(path: string, contents: string): Promise<void> {
  await secureFile(path, contents, 0o700);
}

async function writeReleaseManifest(release: string): Promise<string> {
  const paths = execFileSync('find', ['.', '-type', 'f', '!', '-name', 'release.manifest', '-printf', '%P\n'], {
    cwd: release,
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean).sort();
  const lines: string[] = [];
  for (const path of paths) {
    const contents = await readFile(join(release, path));
    lines.push(`${sha256(contents)}  ${path}`);
  }
  const manifest = `${lines.join('\n')}\n`;
  await secureFile(join(release, 'release.manifest'), manifest, 0o600);
  return sha256(Buffer.from(manifest));
}

async function treeFingerprint(root: string, excludedTopLevel: string[] = []): Promise<string> {
  const entries = execFileSync('find', ['.', '-xdev', '-printf', '%y %m %u:%g %s %T@ %p %l\n'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\n').filter(Boolean).filter((line) => !excludedTopLevel.some((entry) => line.includes(` ./${entry}/`) || line.endsWith(` ./${entry}`)));
  const fileHashes: string[] = [];
  for (const line of entries) {
    const normalized = line.trimEnd();
    const match = / (\.\/[^ ]+)$/.exec(normalized);
    if (line.startsWith('f ') && match !== null) fileHashes.push(`${match[1]}=${sha256(await readFile(join(root, match[1])))}`);
  }
  return sha256(Buffer.from([...entries, ...fileHashes].sort().join('\n')));
}

async function optionalRead(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function target(root: string, absolute: string): string {
  return `${root}${absolute}`;
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

const fakeSystemctl = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
root=\${GWM_FIXTURE_ROOT:?}
scope=new
for arg in "$@"; do [ "$arg" = --user ] && scope=old; done
command=
for arg in "$@"; do
  case "$arg" in show|stop|start|enable|disable|daemon-reload|is-active) command=$arg; break;; esac
done
[ "$scope" != new ] || [ ! -e "$state/fail-new-system-manager" ] || exit 1
case "$scope:$command" in
  old:show)
    if printf '%s\n' "$*" | grep -q -- '--value'; then
      tr -d '\\n' <"$state/old-enabled"
      printf '\\n'
      exit 0
    fi
    if printf '%s\n' "$*" | grep -q -- '--property=SubState'; then
      if [ -e "$state/delay-old-stop" ] && [ "$(tr -d '\\n' <"$state/old-active")" = deactivating ]; then
        count=$(tr -d '\\n' <"$state/old-stop-show-count")
        count=$((count + 1))
        printf '%s\\n' "$count" >"$state/old-stop-show-count"
        if [ "$count" -ge 3 ]; then
          printf 'inactive\\n' >"$state/old-active"
          printf '0\\n' >"$state/old-pid"
          : >"$state/old-cgroup-pids"
          printf '0\\n' >"$state/old-gpu-owner"
          printf '0\\n' >"$state/port8080"
          : >"$state/old-job"
        fi
      fi
      active=$(tr -d '\\n' <"$state/old-active")
      sub=running
      [ "$active" != deactivating ] || sub=stop-sigterm
      [ "$active" != inactive ] || sub=dead
      printf 'ActiveState=%s\\nSubState=%s\\nMainPID=%s\\nControlGroup=/user.slice/user-1001.slice/user@1001.service/app.slice/qwen38.service\\nJob=%s\\n' \\
        "$active" "$sub" "$(tr -d '\\n' <"$state/old-pid")" "$(tr -d '\\n' <"$state/old-job")"
      exit 0
    fi
    if [ -e "$state/delay-old-start" ] && [ "$(tr -d '\\n' <"$state/old-active")" = activating ]; then
      count=$(tr -d '\\n' <"$state/old-start-show-count")
      count=$((count + 1))
      printf '%s\\n' "$count" >"$state/old-start-show-count"
      if [ "$count" -ge 3 ]; then
        printf 'active\\n' >"$state/old-active"
        printf '4242\\n' >"$state/old-pid"
        printf '4242\\n4343\\n' >"$state/old-cgroup-pids"
        printf '1\\n' >"$state/old-gpu-owner"
        printf '1\\n' >"$state/port8080"
      fi
    fi
    printf 'LoadState=loaded\\nActiveState=%s\\nUnitFileState=%s\\nFragmentPath=%s/home/agentops/.config/systemd/user/qwen38.service\\nMainPID=%s\\nControlGroup=/user.slice/user-1001.slice/user@1001.service/app.slice/qwen38.service\\n' \\
      "$(tr -d '\\n' <"$state/old-active")" "$(tr -d '\\n' <"$state/old-enabled")" "$root" "$(tr -d '\\n' <"$state/old-pid")"
    ;;
  old:stop)
    printf 'old stop\\n' >>"$state/events.log"
    if [ -e "$state/delay-old-stop" ]; then
      printf 'deactivating\\n' >"$state/old-active"
      printf 'stop\\n' >"$state/old-job"
      sleep 30
    fi
    printf 'inactive\\n' >"$state/old-active"
    printf '0\\n' >"$state/old-pid"
    [ -e "$state/keep-port-busy" ] || printf '0\\n' >"$state/port8080"
    if [ -e "$state/keep-old-child" ]; then
      printf '4343\\n' >"$state/old-cgroup-pids"
      printf '1\\n' >"$state/old-gpu-owner"
    else
      if [ -e "$state/fifo-old-cgroup-after-stop" ]; then
        /usr/bin/rm -f -- "$state/old-cgroup-pids"
        /usr/bin/mkfifo -- "$state/old-cgroup-pids"
      else
        : >"$state/old-cgroup-pids"
      fi
      printf '0\\n' >"$state/old-gpu-owner"
    fi
    : >"$state/old-job"
    [ ! -e "$state/hang-old-stop-after-effect" ] || sleep 30
    [ ! -e "$state/hang-rollback-mutations-after-effect" ] || sleep 30
    ;;
  old:start)
    printf 'old start\\n' >>"$state/events.log"
    if [ -p "$state/old-cgroup-pids" ]; then
      /usr/bin/rm -f -- "$state/old-cgroup-pids"
      : >"$state/old-cgroup-pids"
    fi
    if [ -e "$state/fail-old-start" ]; then
      printf 'failed\\n' >"$state/old-active"
      printf '0\\n' >"$state/old-pid"
      : >"$state/old-cgroup-pids"
      printf '0\\n' >"$state/old-gpu-owner"
      printf '0\\n' >"$state/port8080"
    elif [ -e "$state/delay-old-start" ]; then
      printf 'activating\\n' >"$state/old-active"
      printf '0\\n' >"$state/old-pid"
      : >"$state/old-cgroup-pids"
      printf '0\\n' >"$state/old-gpu-owner"
      printf '0\\n' >"$state/port8080"
      printf '0\\n' >"$state/old-start-show-count"
    else
      printf 'active\\n' >"$state/old-active"
      printf '4242\\n' >"$state/old-pid"
      printf '4242\\n4343\\n' >"$state/old-cgroup-pids"
      printf '1\\n' >"$state/old-gpu-owner"
      printf '1\\n' >"$state/port8080"
    fi
    [ ! -e "$state/hang-rollback-mutations-after-effect" ] || sleep 30
    ;;
  old:enable)
    printf 'old enable\\n' >>"$state/events.log"
    [ -e "$state/fail-old-enable-state" ] || printf 'enabled\\n' >"$state/old-enabled"
    [ ! -e "$state/hang-rollback-mutations-after-effect" ] || sleep 30
    ;;
  old:disable)
    printf 'old disable\\n' >>"$state/events.log"
    printf 'disabled\\n' >"$state/old-enabled"
    [ ! -e "$state/hang-old-disable-after-effect" ] || sleep 30
    ;;
  new:daemon-reload)
    printf 'new daemon-reload\\n' >>"$state/events.log"
    if [ -e "$state/fail-new-daemon-reload-once" ]; then
      count=$(tr -d '\\n' <"$state/new-daemon-reload-count")
      count=$((count + 1))
      printf '%s\\n' "$count" >"$state/new-daemon-reload-count"
      [ "$count" -ne 1 ] || exit 42
    fi
    if [ -e "$state/hang-final-daemon-reload" ] && [ ! -e "$root/etc/systemd/system/qwen38-workload-manager.service" ]; then sleep 30; fi
    ;;
  new:stop)
    printf 'new stop\\n' >>"$state/events.log"
    if [ -e "$state/hang-new-stop-before-cancel" ] && [ -s "$state/new-job" ]; then sleep 30; fi
    printf 'inactive\\n' >"$state/new-active"
    printf '0\\n' >"$state/new-pid"
    if [ -p "$state/new-cgroup-pids" ]; then
      /usr/bin/rm -f -- "$state/new-cgroup-pids"
      : >"$state/new-cgroup-pids"
    fi
    if [ -e "$state/fifo-new-cgroup-on-stop" ]; then
      /usr/bin/rm -f -- "$state/new-cgroup-pids"
      /usr/bin/mkfifo -- "$state/new-cgroup-pids"
    else
      : >"$state/new-cgroup-pids"
    fi
    : >"$state/new-job"
    [ -e "$state/keep-port-busy" ] || printf '0\\n' >"$state/port8080"
    [ ! -e "$state/hang-rollback-mutations-after-effect" ] || sleep 30
    ;;
  new:disable)
    printf 'new disable\\n' >>"$state/events.log"
    printf 'disabled\\n' >"$state/new-enabled"
    unlink "$root/etc/systemd/system/multi-user.target.wants/qwen38-workload-manager.service" 2>/dev/null || true
    if [ -e "$state/hang-new-disable-system-manager-after-effect" ]; then
      : >"$state/fail-new-system-manager"
      sleep 30
    fi
    [ ! -e "$state/hang-rollback-mutations-after-effect" ] || sleep 30
    ;;
  new:enable)
    printf 'new enable\\n' >>"$state/events.log"
    printf 'enabled\\n' >"$state/new-enabled"
    mkdir -p "$root/etc/systemd/system/multi-user.target.wants"
    ln -sf "$root/etc/systemd/system/qwen38-workload-manager.service" "$root/etc/systemd/system/multi-user.target.wants/qwen38-workload-manager.service"
    if [ -e "$state/fail-new-enable-after-runtime-effect" ]; then
      printf 'active\\n' >"$state/new-active"
      printf '5252\\n' >"$state/new-pid"
      printf '5252\\n' >"$state/new-cgroup-pids"
      printf '1\\n' >"$state/port8080"
      exit 42
    fi
    if [ -e "$state/hang-new-enable-after-effect" ]; then
      : >"$state/fail-new-system-manager"
      sleep 30
    fi
    ;;
  new:start)
    printf 'new start\\n' >>"$state/events.log"
    printf '%s\\n' "$*" >"$state/new-start-args"
    [ ! -e "$state/fail-new-start" ] || exit 1
    [ ! -e "$state/hang-new-start" ] || sleep 30
    if [ -e "$state/queue-new-start-job" ]; then
      printf 'inactive\\n' >"$state/new-active"
      printf '0\\n' >"$state/new-pid"
      : >"$state/new-cgroup-pids"
      printf '0\\n' >"$state/port8080"
      printf 'start\\n' >"$state/new-job"
    elif [ -e "$state/queued-new-start" ] && printf '%s\\n' "$*" | grep -q -- '--no-block'; then
      :
    elif [ -e "$state/terminal-new-failed" ]; then
      printf 'failed\\n' >"$state/new-active"
      printf '0\\n' >"$state/new-pid"
      : >"$state/new-cgroup-pids"
      printf '0\\n' >"$state/port8080"
    elif [ -e "$state/terminal-new-auto-restart" ]; then
      printf 'activating\\n' >"$state/new-active"
      printf '0\\n' >"$state/new-pid"
      : >"$state/new-cgroup-pids"
      printf '0\\n' >"$state/port8080"
    elif [ -e "$state/terminal-new-not-found" ]; then
      printf 'inactive\\n' >"$state/new-active"
      printf '0\\n' >"$state/new-pid"
      : >"$state/new-cgroup-pids"
      printf '0\\n' >"$state/port8080"
    elif [ -e "$state/delay-new-readiness" ]; then
      printf 'activating\\n' >"$state/new-active"
      printf '0\\n' >"$state/new-pid"
      : >"$state/new-cgroup-pids"
      printf '0\\n' >"$state/port8080"
      printf '0\\n' >"$state/new-start-show-count"
    else
      printf 'active\\n' >"$state/new-active"
      printf '5252\\n' >"$state/new-pid"
      if [ -e "$state/hang-new-cgroup-readiness-once" ]; then
        /usr/bin/rm -f -- "$state/new-cgroup-pids"
        /usr/bin/mkfifo -- "$state/new-cgroup-pids"
      elif [ -e "$state/keep-new-child" ]; then
        printf '5252\\n5353\\n' >"$state/new-cgroup-pids"
      else
        printf '5252\\n' >"$state/new-cgroup-pids"
      fi
      printf '1\\n' >"$state/port8080"
    fi
    ;;
  new:show)
    if printf '%s\n' "$*" | grep -q -- '--value'; then
      tr -d '\\n' <"$state/new-enabled"
      printf '\\n'
      exit 0
    fi
    count=$(tr -d '\\n' <"$state/new-start-show-count")
    if printf '%s\\n' "$*" | grep -q -- '--property=SubState'; then
      count=$((count + 1))
      printf '%s\\n' "$count" >"$state/new-start-show-count"
    fi
    if [ -e "$state/delay-new-readiness" ] && [ "$count" -ge 35 ]; then
      printf 'active\\n' >"$state/new-active"
      printf '5252\\n' >"$state/new-pid"
      printf '5252\\n' >"$state/new-cgroup-pids"
      printf '1\\n' >"$state/port8080"
    fi
    load=loaded
    sub=running
    [ "$(tr -d '\\n' <"$state/new-active")" != inactive ] || sub=dead
    result=success
    restarts=0
    if [ "$(tr -d '\\n' <"$state/new-active")" = activating ]; then sub=start; fi
    if [ -e "$state/terminal-new-failed" ]; then sub=failed; result=exit-code; fi
    if [ -e "$state/terminal-new-auto-restart" ]; then sub=auto-restart; result=exit-code; restarts=1; fi
    [ ! -e "$state/terminal-new-not-found" ] || load=not-found
    control_group=/system.slice/qwen38-workload-manager.service
    if [ -e "$state/queued-new-start" ] && [ "$(tr -d '\\n' <"$state/new-active")" = inactive ]; then sub=dead; control_group=; fi
    if [ -e "$state/terminal-new-wrong-cgroup" ] && [ "$(tr -d '\\n' <"$state/new-active")" != inactive ]; then control_group=/system.slice/unrelated.service; fi
    printf 'LoadState=%s\\nActiveState=%s\\nSubState=%s\\nResult=%s\\nNRestarts=%s\\nMainPID=%s\\nControlGroup=%s\\nJob=%s\\n' \\
      "$load" "$(tr -d '\\n' <"$state/new-active")" "$sub" "$result" "$restarts" "$(tr -d '\\n' <"$state/new-pid")" "$control_group" "$(tr -d '\\n' <"$state/new-job")"
    [ ! -e "$state/terminal-new-malformed-output" ] || printf 'NRestarts=0\\n'
    if [ -e "$state/fail-new-show-after-output" ] && [ "$(tr -d '\\n' <"$state/new-active")" != inactive ]; then exit 42; fi
    ;;
  new:is-active) [ "$(tr -d '\\n' <"$state/new-active")" = active ];;
  *) printf 'unexpected systemctl invocation: %s\\n' "$*" >&2; exit 97;;
esac
`;

const fakeSs = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
root=\${GWM_FIXTURE_ROOT:?}
if [ -e "$state/hang-canary-port-ss-after-old-stop" ] \
  && [ "$(tr -d '\\n' <"$state/old-active")" = inactive ] \
  && printf '%s\n' "$*" | grep -Eq -- ':(18081|18082|18181|18182)'; then
  unlink "$state/hang-canary-port-ss-after-old-stop"
  sleep 30
fi
if printf '%s\n' "$*" | grep -q -- ':8080' \
  && [ -e "$state/fail-first-new-absence-ss" ] \
  && [ -e "$root/etc/systemd/system/qwen38-workload-manager.service" ] \
  && [ "$(tr -d '\\n' <"$state/old-active")" = inactive ] \
  && [ "$(tr -d '\\n' <"$state/new-active")" = inactive ]; then
  count=$(tr -d '\\n' <"$state/new-absence-ss-count")
  count=$((count + 1))
  printf '%s\n' "$count" >"$state/new-absence-ss-count"
  [ "$count" -ne 1 ] || exit 42
fi
case "$*" in
  *:8080*)
    if [ "$(tr -d '\\n' <"$state/port8080")" = 1 ]; then
      if [ "$(tr -d '\\n' <"$state/old-active")" = active ] || [ -e "$state/keep-port-busy" ]; then
        if [ -e "$state/specific-old-listener" ]; then
          printf 'LISTEN 0 512 10.0.0.0:8080 0.0.0.0:* users:(("llama-server",pid=4242,fd=3))\\n'
        else
          printf 'LISTEN 0 512 0.0.0.0:8080 0.0.0.0:* users:(("llama-server",pid=4242,fd=3))\\n'
        fi
        if [ -e "$state/duplicate-old-listener" ]; then
          printf 'LISTEN 0 512 0.0.0.0:8080 0.0.0.0:* users:(("intruder",pid=6262,fd=4))\\n'
        fi
        [ ! -e "$state/fail-old-ss-after-output" ] || exit 42
      elif [ "$(tr -d '\\n' <"$state/new-active")" = active ]; then
        printf 'LISTEN 0 512 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=5252,fd=3))\\n'
        if [ -e "$state/duplicate-new-listener" ]; then
          printf 'LISTEN 0 512 0.0.0.0:8080 0.0.0.0:* users:(("intruder",pid=6363,fd=4))\\n'
        fi
        [ ! -e "$state/fail-new-ss-after-output" ] || exit 42
      fi
    fi
    ;;
  *:18080*)
    if [ -e "$state/fail-child-ss" ] && [ "$(tr -d '\\n' <"$state/new-active")" = active ]; then exit 42; fi
    ;;
  *:18081*|*:18082*|*:18181*|*:18182*) ;;
  *) printf 'unexpected ss invocation: %s\\n' "$*" >&2; exit 97;;
esac
`;

const fakeUfw = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
if [ -e "$state/hang-ufw-after-old-stop" ] && [ "$(tr -d '\\n' <"$state/old-active")" = inactive ]; then
  unlink "$state/hang-ufw-after-old-stop"
  sleep 30
fi
if [ "$*" = 'status verbose' ]; then
  printf 'Status: active\\nLogging: on (low)\\n'
  if [ -e "$state/default-allow-ufw" ]; then
    printf 'Default: allow (incoming), allow (outgoing), disabled (routed)\\n'
  else
    printf 'Default: deny (incoming), allow (outgoing), disabled (routed)\\n'
  fi
  printf '\\nTo                         Action      From\\n'
  if [ -e "$state/summary-deny-before-allow" ]; then
    printf '8080/tcp                   DENY IN     Anywhere\\n'
    printf '8080/tcp on enp5s0         ALLOW IN    192.168.3.0/24\\n'
  elif [ -e "$state/unsafe-ufw" ]; then
    printf '8080/tcp                   ALLOW IN    Anywhere\\n'
  elif [ -e "$state/smuggled-ufw" ]; then
    printf '8080/tcp                   ALLOW IN    192.168.3.0/24 10.0.0.0/8\\n'
  elif [ -e "$state/range-ufw" ]; then
    printf '8000:9000/tcp              ALLOW IN    Anywhere\\n'
  else
    printf '8080/tcp on enp5s0         ALLOW IN    192.168.3.0/24\\n'
  fi
elif [ "$*" = 'show raw' ]; then
  printf 'IPV4 (raw):\\n'
  if [ -e "$state/raw-input-policy-accept" ]; then
    printf 'Chain INPUT (policy ACCEPT)\\n'
  else
    printf 'Chain INPUT (policy DROP)\\n'
  fi
  if [ -e "$state/custom-chain-ufw" ]; then
    printf 'GWM-CUSTOM all -- 0.0.0.0/0 0.0.0.0/0\\n'
  else
    printf 'ufw-user-input all -- 0.0.0.0/0 0.0.0.0/0\\n'
  fi
  printf 'Chain ufw-user-input (1 references)\\n'
  if [ -e "$state/missing-trusted-raw-rule" ]; then
    printf 'ACCEPT all -- 0.0.0.0/0 0.0.0.0/0 ctstate RELATED,ESTABLISHED\\n'
  elif [ -e "$state/preceding-raw-drop" ]; then
    printf 'DROP tcp -- 0.0.0.0/0 0.0.0.0/0 tcp dpt:8080\\n'
    printf 'ACCEPT tcp -- 192.168.3.0/24 0.0.0.0/0 tcp dpt:8080\\n'
  elif [ -e "$state/unsafe-raw-ufw" ] || [ -e "$state/range-ufw" ]; then
    printf 'ACCEPT tcp -- 0.0.0.0/0 0.0.0.0/0 tcp dpts:8000:9000\\n'
  else
    printf 'ACCEPT tcp -- 192.168.3.0/24 0.0.0.0/0 tcp dpt:8080\\n'
  fi
  printf 'Chain GWM-CUSTOM (1 references)\\n'
  if [ -e "$state/custom-chain-ufw" ]; then
    printf 'ACCEPT tcp -- 0.0.0.0/0 0.0.0.0/0 tcp dpt:8080\\n'
  fi
  printf 'IPV6 (raw):\\nChain INPUT (policy DROP)\\n'
  if [ -e "$state/ipv6-ufw" ]; then printf 'ufw6-user-input all -- ::/0 ::/0\\n'; fi
  printf 'Chain ufw6-user-input (1 references)\\n'
  if [ -e "$state/ipv6-ufw" ]; then printf 'ACCEPT tcp -- ::/0 ::/0 tcp dpt:8080\\n'; fi
else
  printf 'unexpected ufw invocation: %s\\n' "$*" >&2
  exit 97
fi
`;

const fakeIptablesSave = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
[ "$*" = '-t filter' ] || { printf 'unexpected iptables-save invocation: %s\\n' "$*" >&2; exit 97; }
family=ipv4
[ "\${0##*/}" != ip6tables-save ] || family=ipv6

if { [ "$family" = ipv4 ] && [ -e "$state/fail-iptables-save-after-output" ]; } \\
  || { [ "$family" = ipv6 ] && [ -e "$state/fail-ip6tables-save-after-output" ]; } \\
  || { [ "$family" = ipv4 ] && [ -e "$state/fail-iptables-save-after-output-after-old-stop" ] && [ "$(tr -d '\\n' <"$state/old-active")" = inactive ]; } \\
  || { [ "$family" = ipv6 ] && [ -e "$state/fail-ip6tables-save-after-output-after-old-stop" ] && [ "$(tr -d '\\n' <"$state/old-active")" = inactive ]; }; then
  printf '# Generated by %s v1.8.10 (nf_tables)\\n*filter\\n' "\${0##*/}"
  exit 42
fi

if [ "$family" = ipv6 ]; then
  printf '%s\\n' \\
    '# Generated by ip6tables-save v1.8.10 (nf_tables)' \\
    '*filter' \\
    ':INPUT DROP [11:704]' \\
    ':FORWARD DROP [0:0]' \\
    ':OUTPUT ACCEPT [19:2001]' \\
    ':ufw6-before-input - [8:640]' \\
    ':ufw6-user-input - [0:0]' \\
    '-A INPUT -j ufw6-before-input' \\
    '-A INPUT -j ufw6-user-input' \\
    '-A ufw6-before-input -i lo -j ACCEPT' \\
    '-A ufw6-before-input -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT' \\
    '-A ufw6-before-input -m rt --rt-type 0 -j DROP' \\
    '-A ufw6-before-input -p ipv6-icmp -m ipv6-icmp --icmpv6-type 133 -m hl --hl-eq 255 -j ACCEPT' \\
    '-A ufw6-before-input -p ipv6-icmp -m ipv6-icmp --icmpv6-type 134 -m hl --hl-eq 255 -j ACCEPT' \\
    '-A ufw6-before-input -p ipv6-icmp -m ipv6-icmp --icmpv6-type 130 -m hl --hl-eq 1 -j ACCEPT'
  if [ -e "$state/save-ipv6-accept" ] || [ -e "$state/ipv6-ufw" ]; then
    printf '%s\\n' '-A ufw6-user-input -p tcp -m tcp --dport 8080 -j ACCEPT'
  fi
  printf '%s\\n' 'COMMIT' '# Completed by ip6tables-save v1.8.10 (nf_tables)'
  exit 0
fi

input_policy=DROP
if [ -e "$state/save-input-policy-accept" ] || [ -e "$state/raw-input-policy-accept" ]; then input_policy=ACCEPT; fi
printf '%s\\n' \\
  '# Generated by iptables-save v1.8.10 (nf_tables)' \\
  '*filter' \\
  ":INPUT $input_policy [23:1840]" \\
  ':FORWARD DROP [0:0]' \\
  ':OUTPUT ACCEPT [31:4096]'
if [ -e "$state/save-duplicate-input-chain" ]; then printf '%s\\n' ':INPUT DROP [0:0]'; fi
printf '%s\\n' \\
  ':GWM-CUSTOM - [0:0]' \\
  ':ufw-before-logging-input - [0:0]' \\
  ':ufw-before-input - [18:1450]' \\
  ':ufw-not-local - [2:160]' \\
  ':ufw-user-input - [1:64]' \\
  ':ufw-after-input - [0:0]' \\
  ':ufw-reject-input - [0:0]' \\
  ':ufw-track-input - [0:0]'
if [ -e "$state/save-custom-chain-broad-accept" ] || [ -e "$state/custom-chain-ufw" ]; then
  printf '%s\\n' '-A INPUT -j GWM-CUSTOM'
fi
if [ -e "$state/save-unsupported-ambiguity" ]; then
  printf '%s\\n' '-A INPUT -m set --match-set gateway-sources src -j GWM-CUSTOM'
fi
printf '%s\\n' \\
  '-A INPUT -j ufw-before-logging-input' \\
  '-A INPUT -j ufw-before-input' \\
  '-A INPUT -j ufw-after-input' \\
  '-A INPUT -j ufw-reject-input' \\
  '-A INPUT -j ufw-track-input' \\
  '-A INPUT -p udp -j GWM-CUSTOM' \\
  '-A GWM-CUSTOM -p tcp -m tcp --dport 8080 -j ACCEPT' \\
  '-A ufw-before-logging-input -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW BLOCK -j ACCEPT GWM-CUSTOM] "' \\
  '-A ufw-before-input -i lo -j ACCEPT' \\
  '-A ufw-before-input -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT' \\
  '-A ufw-before-input -m conntrack --ctstate INVALID -j DROP' \\
  '-A ufw-before-input -j ufw-not-local' \\
  '-A ufw-before-input -p udp -m udp --sport 67 --dport 68 -j ACCEPT' \\
  '-A ufw-before-input -j ufw-user-input' \\
  '-A ufw-not-local -m addrtype --dst-type LOCAL -j RETURN' \\
  '-A ufw-not-local -m addrtype --dst-type MULTICAST -j RETURN' \\
  '-A ufw-not-local -m addrtype --dst-type BROADCAST -j RETURN' \\
  '-A ufw-not-local -j DROP' \\
  '-A ufw-after-input -p udp -m udp --dport 137 -j DROP'
if [ -e "$state/save-malformed-rule" ]; then printf '%s\\n' '-A ufw-user-input -p tcp --dport 8080 -j'; fi
if [ -e "$state/save-preceding-drop" ] || [ -e "$state/preceding-raw-drop" ]; then
  printf '%s\\n' '-A ufw-user-input -i enp5s0 -s 192.168.3.0/24 -p tcp -m tcp --dport 8080 -j DROP'
fi
if [ -e "$state/save-broad-accept" ] || [ -e "$state/unsafe-raw-ufw" ] || [ -e "$state/range-ufw" ]; then
  printf '%s\\n' '-A ufw-user-input -p tcp -m tcp --dport 8080 -j ACCEPT'
fi
if [ ! -e "$state/save-missing-exact" ] && [ ! -e "$state/missing-trusted-raw-rule" ]; then
  printf '%s\\n' '-A ufw-user-input -i enp5s0 -s 192.168.3.0/24 -p tcp -m tcp --dport 8080 -j ACCEPT'
  if [ -e "$state/save-duplicate-exact" ]; then
    printf '%s\\n' '-A ufw-user-input -i enp5s0 -s 192.168.3.0/24 -p tcp -m tcp --dport 8080 -j ACCEPT'
  fi
fi
if [ -e "$state/save-negated-source-accept" ]; then
  printf '%s\\n' '-A ufw-user-input ! -s 192.168.3.0/24 -p tcp -m tcp --dport 8080 -j ACCEPT'
fi
if [ -e "$state/save-negated-interface-accept" ]; then
  printf '%s\\n' '-A ufw-user-input ! -i lo -p tcp -m tcp --dport 8080 -j ACCEPT'
fi
if [ -e "$state/save-negated-port-accept" ]; then
  printf '%s\\n' '-A ufw-user-input -p tcp -m tcp ! --dport 22 -j ACCEPT'
fi
if [ -e "$state/save-broad-untracked-accept" ]; then
  printf '%s\\n' '-A ufw-user-input -p tcp -m tcp --dport 8080 -m conntrack --ctstate UNTRACKED -j ACCEPT'
fi
printf '%s\\n' 'COMMIT' '# Completed by iptables-save v1.8.10 (nf_tables)'
`;

const fakeSha256sum = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
if [ -e "$state/hang-explicit-release-verification" ] \
  && printf '%s\n' "$*" | grep -q -- '/opt/qwen38-workload-manager/releases/'; then
  exec sleep 30
fi
if [ -e "$state/delay-explicit-release-verification" ] \
  && printf '%s\n' "$*" | grep -q -- '/opt/qwen38-workload-manager/releases/'; then
  unlink "$state/delay-explicit-release-verification"
  sleep 2
fi
if [ -e "$state/hang-next-sha256sum-after-old-stop" ] && [ "$(tr -d '\\n' <"$state/old-active")" = inactive ]; then
  unlink "$state/hang-next-sha256sum-after-old-stop"
  sleep 30
fi
if [ -e "$state/hang-staging-cleanup-sha-after-old-stop" ] \
  && [ "$(tr -d '\\n' <"$state/old-active")" = inactive ] \
  && printf '%s\n' "$*" | grep -q -- '/.installing-'; then
  sleep 30
fi
exec /usr/bin/sha256sum "$@"
`;

const fakeStat = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
if [ -e "$state/hang-once-rollback-bootstrap-stat" ] \
  && [ "$(tr -d '\\n' <"$state/old-active")" = inactive ] \
  && printf '%s\n' "$*" | grep -q -- '/var/lib/qwen38-workload-manager-migrations'; then
  unlink "$state/hang-once-rollback-bootstrap-stat"
  sleep 30
fi
if [ -e "$state/partial-failed-credential-stat-after-old-stop" ] \
  && [ "$(tr -d '\\n' <"$state/old-active")" = inactive ] \
  && printf '%s\n' "$*" | grep -q -- '/credentials/inference.key'; then
  unlink "$state/partial-failed-credential-stat-after-old-stop"
  /usr/bin/stat "$@"
  exit 42
fi
exec /usr/bin/stat "$@"
`;

const fakeUnlink = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
if [ -e "$state/hang-release-unlink-after-effect" ] \
  && printf '%s\n' "$*" | grep -q -- '/opt/qwen38-workload-manager/releases/' \
  && ! printf '%s\n' "$*" | grep -q -- '/release.manifest'; then
  /usr/bin/unlink "$state/hang-release-unlink-after-effect"
  /usr/bin/unlink "$@"
  exec sleep 30
fi
exec /usr/bin/unlink "$@"
`;

const fakeRmdir = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
if [ -e "$state/hang-release-rmdir-after-effect" ] \
  && printf '%s\\n' "$*" | grep -q -- '/opt/qwen38-workload-manager/releases/' \
  && ! printf '%s\\n' "$*" | grep -Eq -- '/releases/[0-9a-f]{64}$'; then
  /usr/bin/unlink "$state/hang-release-rmdir-after-effect"
  /usr/bin/rmdir "$@"
  exec sleep 30
fi
exec /usr/bin/rmdir "$@"
`;

const fakeCat = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
if [ -e "$state/hang-new-cgroup-readiness-once" ] \
  && printf '%s\\n' "$*" | grep -q -- "$state/new-cgroup-pids"; then
  /usr/bin/unlink "$state/hang-new-cgroup-readiness-once"
  /usr/bin/rm -f -- "$state/new-cgroup-pids"
  printf '5252\\n' >"$state/new-cgroup-pids"
  sleep 30
fi
exec /usr/bin/cat "$@"
`;

const fakeSync = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
printf '%s\\n' "$*" >>"$state/sync.log"
exec /usr/bin/sync "$@"
`;

const fakeCurl = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
url=
for arg in "$@"; do case "$arg" in http://*) url=$arg;; esac; done
case "$url" in
  http://127.0.0.1:8080/health)
    if [ "$(tr -d '\\n' <"$state/new-active")" = active ] && [ -e "$state/fail-new-readiness" ]; then exit 22; fi
    [ "$(tr -d '\\n' <"$state/new-active")" = active ] || [ "$(tr -d '\\n' <"$state/old-active")" = active ]
    printf '{"status":"ok"}'
    ;;
  http://127.0.0.1:8080/props)
    printf '401'
    [ ! -e "$state/fail-props-after-output" ] || exit 42
    ;;
  *) printf 'unexpected curl invocation: %s\\n' "$*" >&2; exit 97;;
esac
`;

const fakeCanary = `#!/bin/sh
set -eu
state=\${GWM_FAKE_STATE:?}
kind=\${QWEN38_CANARY_KIND:?}
mode=\${QWEN38_CANARY_MODE:?}
if [ "$mode" = artifact-only ]; then
  [ "$kind" = real ] || exit 96
  [ -z "\${QWEN38_CANARY_HOST-}" ] || exit 97
  [ -z "\${QWEN38_CANARY_PORT-}" ] || exit 98
  [ -z "\${QWEN38_CANARY_CHILD_PORT-}" ] || exit 99
  [ -z "\${CREDENTIALS_DIRECTORY-}" ] || exit 100
  printf 'canary artifact-only\\n' >>"$state/events.log"
  printf 'artifact-only\\n' >>"$state/canary.log"
  [ "$(tr -d '\\n' <"$state/old-active")" = active ] || exit 101
  [ ! -e "$state/fail-artifact-canary" ] || exit 102
  exit 0
fi
[ "$mode" = full ] || exit 103
host=\${QWEN38_CANARY_HOST:?}
port=\${QWEN38_CANARY_PORT:?}
printf 'canary %s %s %s\\n' "$kind" "$host" "$port" >>"$state/events.log"
printf '%s:%s:%s\\n' "$kind" "$host" "$port" >>"$state/canary.log"
[ "$port" != 8080 ] || exit 91
[ ! -e "$state/fail-$kind-canary" ] || exit 92
if [ "$kind" = real ]; then
  [ "$(tr -d '\\n' <"$state/old-active")" = inactive ] || exit 93
  [ ! -s "$state/old-cgroup-pids" ] || exit 94
  [ "$(tr -d '\\n' <"$state/old-gpu-owner")" = 0 ] || exit 95
fi
if [ "$kind" = real ] && [ -e "$state/mutate-credential" ]; then
  printf 'INFERENCE-SECRET\\n' >"$CREDENTIALS_DIRECTORY/inference.key"
  chmod 0600 "$CREDENTIALS_DIRECTORY/inference.key"
fi
if [ "$kind" = fake ] && [ -e "$state/mutate-source-canary" ]; then
  printf '%s\\n' '#!/bin/sh' 'printf "MUTATED\\n" >>"$GWM_FAKE_STATE/mutated-canary.log"' 'exit 0' >"$GWM_RELEASE_SOURCE/canary/real-canary"
  chmod 0700 "$GWM_RELEASE_SOURCE/canary/real-canary"
fi
if [ "$kind" = fake ] && [ -e "$state/mutate-source-config" ]; then
  printf '{"mutated":true}\\n' >"$GWM_RELEASE_SOURCE/config/manager.production.json"
  printf '[Unit]\\nDescription=mutated\\n' >"$GWM_RELEASE_SOURCE/systemd/qwen38-workload-manager.service"
fi
`;
