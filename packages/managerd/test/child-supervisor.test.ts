import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ModelSpec } from '@local/gpu-workload-core';
import { ChildSupervisor } from '../src/child-supervisor.js';
import { Metrics } from '../src/metrics.js';

const models: Record<string, ModelSpec> = {
  base: { id: 'qwen3.8-27b', path: '/catalog/base.gguf', contextSize: 8192, mtp: 2 },
  q4: { id: 'qwen3.8-27b-q4', path: '/catalog/q4.gguf', contextSize: 4096, mtp: 0 },
  ignoreTerm: { id: 'ignore-term', path: '/catalog/ignore-term.gguf', contextSize: 4096, mtp: 0 },
  crashStart: { id: 'crash-start', path: '/catalog/crash-start.gguf', contextSize: 4096, mtp: 0 },
  crashReady: { id: 'crash-ready', path: '/catalog/crash-ready.gguf', contextSize: 4096, mtp: 0 },
  zeroToken: { id: 'zero-token', path: '/catalog/zero-token.gguf', contextSize: 4096, mtp: 0 },
  emptyChoice: { id: 'empty-choice', path: '/catalog/empty-choice.gguf', contextSize: 4096, mtp: 0 },
};
const fixtures: Array<{ supervisor: ChildSupervisor; credentialFd: number; directory: string; priorSecret?: string }> = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    try { await fixture.supervisor.forceStop('test-cleanup'); } catch { /* already exited or identity conflict */ }
    closeSync(fixture.credentialFd);
    if (fixture.priorSecret === undefined) delete process.env.INFERENCE_KEY;
    else process.env.INFERENCE_KEY = fixture.priorSecret;
    await rm(fixture.directory, { recursive: true, force: true });
  }));
});

it('starts one catalog child only after health, props, and authenticated one-token warm-up', async () => {
  const fixture = await fixtureSupervisor();
  const running = await fixture.supervisor.start(models.base);
  expect(running.model).toBe('qwen3.8-27b');
  expect(fixture.supervisor.snapshot()).toMatchObject({ childPid: running.pid, phase: 'READY', lastSignal: undefined });
  expect(fixture.supervisor.argv()).toEqual([
    '--host', '127.0.0.1', '--port', '18080', '--model', '/catalog/base.gguf',
    '--alias', 'qwen3.8-27b', '--ctx-size', '8192',
    '--threads', '10', '--batch-size', '512', '--ubatch-size', '256',
    '--parallel', '1', '--device', 'Vulkan0', '--n-gpu-layers', 'all', '--fit', 'off',
    '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0',
    '--kv-unified', '--no-context-shift', '--cache-ram', '32768', '--load-mode', 'none',
    '--jinja', '--reasoning', 'auto', '--reasoning-format', 'deepseek',
    '--temp', '0.6', '--top-p', '0.5', '--top-k', '15', '--repeat-penalty', '1.0',
    '--metrics', '--offline',
    '--spec-type', 'draft-mtp', '--spec-draft-n-max', '2',
    '--api-key-file', '/proc/self/fd/3', '--no-cors-credentials',
  ]);
  expect(fixture.supervisor.argv().join(' ')).not.toContain(fixture.key);
});

it('rejects a second child owner', async () => {
  const fixture = await fixtureSupervisor();
  await fixture.supervisor.start(models.base);
  await expect(fixture.supervisor.start(models.q4)).rejects.toThrow(/child_already_running/);
});

it('escalates SIGTERM to SIGKILL after the configured timeout', async () => {
  const fixture = await fixtureSupervisor({ stopTimeoutMs: 25 });
  await fixture.supervisor.start(models.ignoreTerm);
  await fixture.supervisor.stop('test');
  expect(fixture.supervisor.snapshot().lastSignal).toBe('SIGKILL');
});

it('cleans up an immediate startup exit and permits a later catalog restart', async () => {
  const fixture = await fixtureSupervisor();
  await expect(fixture.supervisor.start(models.crashStart)).rejects.toThrow(/child_exited/);
  expect(fixture.supervisor.snapshot()).toMatchObject({ phase: 'UNLOADED', childPid: undefined });
  await expect(fixture.supervisor.start(models.base)).resolves.toMatchObject({ model: 'qwen3.8-27b' });
});

it('publishes READY child crashes as FAILED and clears ownership for restart', async () => {
  const moments = [0, 12_500, 13_750];
  const metrics = new Metrics(Object.values(models).map((model) => model.id));
  const fixture = await fixtureSupervisor({ telemetry: metrics, now: () => moments.shift() ?? 13_750 });
  const events: Array<{ readonly child: { readonly model: string } }> = [];
  fixture.supervisor.onUnexpectedExit((event) => events.push(event));
  const running = await fixture.supervisor.start(models.crashReady);
  await waitUntil(() => fixture.supervisor.snapshot().phase === 'FAILED');
  expect(fixture.supervisor.snapshot().childPid).toBeUndefined();
  expect(events).toEqual([{ child: expect.objectContaining({ pid: running.pid, startToken: running.startToken, model: 'crash-ready' }) }]);
  const rendered = metrics.render({ phase: 'FAILED', activeRequestCount: 0 });
  expect(rendered).toContain('manager_child_load_to_health_seconds_sum{model="crash-ready"} 12.5\n');
  expect(rendered).toContain('manager_child_warmup_seconds_sum{model="crash-ready"} 1.25\n');
  expect(rendered).toContain('manager_child_crashes_total{model="crash-ready"} 1\n');
  await expect(fixture.supervisor.start(models.base)).resolves.toMatchObject({ model: 'qwen3.8-27b' });
});

it.each([models.zeroToken, models.emptyChoice])('rejects warm-up without real token evidence for $id', async (model) => {
  const fixture = await fixtureSupervisor();
  await expect(fixture.supervisor.start(model)).rejects.toThrow(/warmup_missing_token/);
  expect(fixture.supervisor.snapshot()).toMatchObject({ phase: 'UNLOADED', childPid: undefined });
});

it('rejects non-catalog input before it can become child argv', async () => {
  const fixture = await fixtureSupervisor();
  const attacker = { id: 'qwen3.8-27b', path: '/attacker.gguf', contextSize: 1, mtp: 0 };
  await expect(fixture.supervisor.start(attacker)).rejects.toThrow(/model_not_in_catalog/);
  expect(fixture.supervisor.argv()).not.toContain('/attacker.gguf');
});

it('handles a child spawn failure without leaving STARTING ownership behind', async () => {
  const fixture = await fixtureSupervisor({ selfDeleteAfterDeviceList: true });
  await expect(fixture.supervisor.start(models.base)).rejects.toThrow(/child_spawn_failed/);
  expect(fixture.supervisor.snapshot()).toMatchObject({ phase: 'UNLOADED', childPid: undefined });
  await fixture.replaceBinary();
  await expect(fixture.supervisor.start(models.base)).resolves.toMatchObject({ model: 'qwen3.8-27b' });
});

it('terminates a spawned child when process identity acquisition fails, then permits a clean restart', async () => {
  let identityReads = 0;
  let failedChildPid: number | undefined;
  const fixture = await fixtureSupervisor({
    processStartToken: (pid) => {
      identityReads += 1;
      if (identityReads === 1) {
        failedChildPid = pid;
        throw new Error('child_identity_unavailable');
      }
      return `fixture-${pid}`;
    },
  });

  await expect(fixture.supervisor.start(models.base)).rejects.toThrow(/child_identity_unavailable/);
  expectProcessMissing(failedChildPid!);
  expect(fixture.supervisor.snapshot()).toMatchObject({ phase: 'UNLOADED', childPid: undefined });
  await expect(fixture.supervisor.start(models.base)).resolves.toMatchObject({ model: 'qwen3.8-27b' });
});

it('validates the binary and model before device enumeration and again before child spawn', async () => {
  let validations = 0;
  const fixture = await fixtureSupervisor({
    validateArtifacts: async () => {
      validations += 1;
      if (validations === 2) throw new Error('artifact_identity_changed');
    },
  });

  await expect(fixture.supervisor.start(models.base)).rejects.toThrow(/artifact_identity_changed/);
  expect(validations).toBe(2);
  expect(fixture.supervisor.argv()).toEqual([]);
  expect(fixture.supervisor.snapshot()).toMatchObject({ phase: 'UNLOADED', childPid: undefined });
});

it('enumerates devices asynchronously with a hard timeout', async () => {
  const fixture = await fixtureSupervisor({
    deviceEnumerationTimeoutMs: 25,
    listDevicesDelaySeconds: 2,
  });
  let eventLoopProgressed = false;
  const progress = new Promise<void>((resolve) => setTimeout(() => {
    eventLoopProgressed = true;
    resolve();
  }, 5));

  const startedAt = Date.now();
  const starting = fixture.supervisor.start(models.base);
  await progress;
  expect(eventLoopProgressed).toBe(true);
  await expect(starting).rejects.toThrow(/device_enumeration_failed/);
  expect(Date.now() - startedAt).toBeLessThan(500);
  expect(fixture.supervisor.snapshot()).toMatchObject({ phase: 'UNLOADED', childPid: undefined });
});

it('force-stops an in-flight device enumeration before it can spawn the model child', async () => {
  const fixture = await fixtureSupervisor({
    deviceEnumerationTimeoutMs: 5_000,
    listDevicesDelaySeconds: 2,
  });
  const starting = fixture.supervisor.start(models.base);
  await waitUntil(() => existsSync(fixture.enumerationMarker));
  await waitUntil(() => existsSync(fixture.enumerationChildMarker));
  const enumerationPid = Number.parseInt(readFileSync(fixture.enumerationMarker, 'utf8'), 10);
  const enumerationChildPid = Number.parseInt(readFileSync(fixture.enumerationChildMarker, 'utf8'), 10);

  const rejected = expect(starting).rejects.toThrow(/device_enumeration_failed|child_start_cancelled/);
  await fixture.supervisor.forceStop('canary_aborted');
  await rejected;

  expect(existsSync(fixture.mainChildMarker)).toBe(false);
  expectProcessMissing(enumerationPid);
  expectProcessMissing(enumerationChildPid);
  expect(fixture.supervisor.snapshot()).toMatchObject({ phase: 'UNLOADED', childPid: undefined });
});

async function fixtureSupervisor(overrides: {
  stopTimeoutMs?: number;
  selfDeleteAfterDeviceList?: boolean;
  deviceEnumerationTimeoutMs?: number;
  listDevicesDelaySeconds?: number;
  validateArtifacts?: (model: ModelSpec) => Promise<void>;
  telemetry?: Metrics;
  now?: () => number;
  processStartToken?: (pid: number) => string;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'managerd-test-'));
  const key = 'a'.repeat(64);
  const keyPath = join(directory, 'inference.key');
  const fakePath = new URL('./fixtures/fake-llama-server.mjs', import.meta.url).pathname;
  const binary = join(directory, 'fake-llama-server');
  const enumerationMarker = join(directory, 'enumeration-started');
  const enumerationChildMarker = join(directory, 'enumeration-child-started');
  const mainChildMarker = join(directory, 'main-child-started');
  const writeBinary = async (selfDelete = false) => {
    const deleteLine = selfDelete ? 'rm -- "$0"\n' : '';
    const delayLine = overrides.listDevicesDelaySeconds === undefined ? '' : `sleep ${overrides.listDevicesDelaySeconds} &\nprintf '%s\\n' "$!" > ${JSON.stringify(enumerationChildMarker)}\nwait "$!"\n`;
    await writeFile(binary, `#!/bin/sh\nif [ "$1" = "--list-devices" ]; then\nprintf '%s\\n' "$$" > ${JSON.stringify(enumerationMarker)}\n${deleteLine}${delayLine}printf '%s\\n' 'Vulkan0: AMD Radeon RX 7900 XTX (RADV NAVI31)'\nexit 0\nfi\nprintf '%s\\n' "$$" > ${JSON.stringify(mainChildMarker)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakePath)} "$@"\n`, { mode: 0o700 });
    await chmod(binary, 0o700);
  };
  await writeBinary(overrides.selfDeleteAfterDeviceList);
  await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  const credentialFd = openSync(keyPath, 'r');
  const priorSecret = process.env.INFERENCE_KEY;
  process.env.INFERENCE_KEY = key;
  const supervisor = new ChildSupervisor({
    binary,
    credentialFd,
    inferenceKey: key,
    catalog: Object.values(models),
    approvedDevice: 'Vulkan0',
    deviceMatcher: /^Vulkan0: AMD Radeon RX 7900 XTX \(RADV NAVI31\)$/,
    stopTimeoutMs: overrides.stopTimeoutMs ?? 250,
    deviceEnumerationTimeoutMs: overrides.deviceEnumerationTimeoutMs ?? 250,
    healthTimeoutMs: 1_000,
    pollIntervalMs: 10,
    validateArtifacts: overrides.validateArtifacts ?? (async () => undefined),
    ...(overrides.telemetry === undefined ? {} : { telemetry: overrides.telemetry }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.processStartToken === undefined ? {} : { processStartToken: overrides.processStartToken }),
  });
  fixtures.push({ supervisor, credentialFd, directory, priorSecret });
  return { supervisor, key, enumerationMarker, enumerationChildMarker, mainChildMarker, replaceBinary: () => writeBinary(false) };
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed_out_waiting_for_child_exit');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function expectProcessMissing(pid: number): void {
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
}
