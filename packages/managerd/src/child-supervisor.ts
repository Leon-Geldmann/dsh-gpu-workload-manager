import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ManagerPhase, ModelSpec } from '@local/gpu-workload-core';
import { credentialStdio } from './credential.js';
import { warmChild } from './warmup.js';
import type { WorkloadTelemetry } from './metrics.js';

export interface RunningChild { readonly pid: number; readonly model: string; readonly startToken: string; }
export interface UnexpectedChildExit { readonly child: RunningChild; }
export interface SupervisorSnapshot { readonly phase: ManagerPhase; readonly childPid?: number; readonly lastSignal?: 'SIGTERM' | 'SIGKILL'; }
interface PendingStart { readonly controller: AbortController; readonly settled: Promise<void>; readonly resolve: () => void; }
export interface ChildSupervisorOptions {
  readonly binary: string;
  readonly credentialFd: number;
  readonly inferenceKey: string;
  readonly catalog: readonly ModelSpec[];
  readonly approvedDevice: string;
  readonly deviceMatcher: RegExp;
  readonly stopTimeoutMs: number;
  readonly deviceEnumerationTimeoutMs: number;
  readonly healthTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly validateArtifacts: (model: ModelSpec) => Promise<void>;
  /** Fixed by production config; alternate loopback ports are reserved for explicit canaries. */
  readonly host?: '127.0.0.1';
  readonly port?: number;
  readonly telemetry?: Pick<WorkloadTelemetry, 'observeChildLoadToHealth' | 'observeChildWarmup' | 'addChildCrash'>;
  readonly now?: () => number;
  /** Injectable only for deterministic process-identity fault tests. */
  readonly processStartToken?: (pid: number) => string;
}

const CHILD_ENV_NAMES = ['PATH', 'LD_LIBRARY_PATH', 'LIBGL_DRIVERS_PATH', 'VK_ICD_FILENAMES', 'VK_LAYER_PATH', 'XDG_RUNTIME_DIR'] as const;

export class ChildSupervisor {
  #child?: ChildProcess;
  #running?: RunningChild;
  #phase: ManagerPhase = 'UNLOADED';
  #lastSignal?: 'SIGTERM' | 'SIGKILL';
  #lastArgv: readonly string[] = [];
  #generation = 0;
  #pendingStart?: PendingStart;
  #catalog: ReadonlyMap<string, ModelSpec>;
  #unexpectedExitListeners = new Set<(event: UnexpectedChildExit) => void>();
  #host: '127.0.0.1';
  #port: number;

  constructor(private readonly options: ChildSupervisorOptions) {
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port ?? 18080;
    if (this.#host !== '127.0.0.1' || !Number.isSafeInteger(this.#port) || this.#port < 1024 || this.#port > 65_535 || this.#port === 8080) throw new Error('invalid_child_endpoint');
    if (!Number.isSafeInteger(options.deviceEnumerationTimeoutMs) || options.deviceEnumerationTimeoutMs < 1 || options.deviceEnumerationTimeoutMs > 30_000) throw new Error('invalid_device_enumeration_timeout');
    this.#catalog = new Map(options.catalog.map((model) => [model.id, Object.freeze({ ...model })]));
    if (this.#catalog.size !== options.catalog.length) throw new Error('invalid_catalog');
  }

  snapshot(): SupervisorSnapshot { return Object.freeze({ phase: this.#phase, childPid: this.#running?.pid, lastSignal: this.#lastSignal }); }
  argv(): readonly string[] { return this.#lastArgv; }
  onUnexpectedExit(listener: (event: UnexpectedChildExit) => void): () => void { this.#unexpectedExitListeners.add(listener); return () => this.#unexpectedExitListeners.delete(listener); }

  async start(requestedModel: ModelSpec): Promise<RunningChild> {
    if (this.#child !== undefined || this.#running !== undefined || this.#pendingStart !== undefined) throw new Error('child_already_running');
    const model = this.#catalogModel(requestedModel);
    const settled = Promise.withResolvers<void>();
    const pending: PendingStart = Object.freeze({ controller: new AbortController(), settled: settled.promise, resolve: settled.resolve });
    this.#pendingStart = pending;
    const generation = ++this.#generation;
    this.#phase = 'STARTING';
    this.#lastSignal = undefined;
    try {
      await this.options.validateArtifacts(model);
      this.#assertPendingStart(generation, pending);
      const device = await this.#enumerateApprovedDevice(pending.controller.signal);
      this.#assertPendingStart(generation, pending);
      await this.options.validateArtifacts(model);
      this.#assertPendingStart(generation, pending);
      const args = this.#buildArgv(model, device);
      this.#lastArgv = Object.freeze([...args]);
      const loadStartedAt = this.#now();
      const child = spawn(this.options.binary, args, { shell: false, stdio: credentialStdio(this.options.credentialFd), env: childEnvironment(this.options.inferenceKey) });
      // The production child is intentionally not allowed to log prompts or headers, but its
      // pipes must still be drained so a verbose Vulkan/llama build cannot deadlock on backpressure.
      child.stdout?.resume();
      child.stderr?.resume();
      this.#child = child;
      child.once('exit', () => this.#onChildExit(generation, child));
      child.once('error', () => this.#onChildExit(generation, child));
      await waitForSpawn(child);
      if (child.pid === undefined) throw new Error('child_spawn_failed');
      this.#assertStartingChild(generation, child);
      const running: RunningChild = Object.freeze({ pid: child.pid, model: model.id, startToken: this.#processStartToken(child.pid) });
      this.#running = running;
      this.#assertGeneration(generation);
      await this.#waitForHealth(generation);
      const healthyAt = this.#now();
      this.#observe(() => this.options.telemetry?.observeChildLoadToHealth(model.id, elapsedSeconds(loadStartedAt, healthyAt)));
      this.#phase = 'WARMING';
      await this.#verifyProps(model.id, model.contextSize);
      await warmChild(this.#endpoint(), this.options.inferenceKey, model.id, AbortSignal.timeout(this.options.healthTimeoutMs));
      this.#assertGeneration(generation);
      this.#observe(() => this.options.telemetry?.observeChildWarmup(model.id, elapsedSeconds(healthyAt, this.#now())));
      this.#phase = 'READY';
      return running;
    } catch (error) {
      await this.#cleanupFailedStart(generation);
      throw error;
    } finally {
      if (this.#pendingStart === pending) {
        this.#pendingStart = undefined;
        if (pending.controller.signal.aborted && this.#child === undefined) this.#phase = 'UNLOADED';
      }
      pending.resolve();
    }
  }

  async stop(_reason: string): Promise<void> {
    const pending = this.#child === undefined ? this.#cancelPendingStart('SIGTERM') : undefined;
    if (pending !== undefined) { await pending; return; }
    await this.#stopWithEscalation();
  }
  async forceStop(_reason: string): Promise<void> {
    const child = this.#child;
    const running = this.#running;
    if (child === undefined) {
      const pending = this.#cancelPendingStart('SIGKILL');
      if (pending !== undefined) await pending;
      return;
    }
    this.#phase = 'STOPPING';
    if (running !== undefined) this.#assertOwnership(child, running);
    ++this.#generation;
    this.#lastSignal = 'SIGKILL';
    await signalChild(child, 'SIGKILL');
    if (!await waitForExit(child, this.options.stopTimeoutMs)) throw new Error('child_stop_timeout');
    this.#clearCurrent(child, 'UNLOADED');
  }

  #catalogModel(value: ModelSpec): ModelSpec {
    const configured = this.#catalog.get(value.id);
    if (configured === undefined || configured.path !== value.path || configured.contextSize !== value.contextSize || configured.mtp !== value.mtp) throw new Error('model_not_in_catalog');
    return configured;
  }

  async #enumerateApprovedDevice(signal: AbortSignal): Promise<string> {
    const stdout = await enumerateDevices(this.options.binary, childEnvironment(this.options.inferenceKey), this.options.deviceEnumerationTimeoutMs, signal);
    const matches = stdout.split(/\r?\n/).filter((line) => matchesDevice(this.options.deviceMatcher, line));
    if (matches.length !== 1 || !matches[0]?.startsWith(`${this.options.approvedDevice}:`)) throw new Error('unapproved_gpu_device');
    return this.options.approvedDevice;
  }

  #buildArgv(model: ModelSpec, device: string): string[] {
    return [
      '--host', this.#host, '--port', String(this.#port), '--model', model.path,
      '--alias', model.id, '--ctx-size', String(model.contextSize),
      '--threads', '10', '--batch-size', '512', '--ubatch-size', '256',
      '--parallel', '1', '--device', device, '--n-gpu-layers', 'all', '--fit', 'off',
      '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0',
      '--kv-unified', '--no-context-shift', '--cache-ram', '32768', '--load-mode', 'none',
      '--jinja', '--reasoning', 'auto', '--reasoning-format', 'deepseek',
      '--temp', '0.6', '--top-p', '0.5', '--top-k', '15', '--repeat-penalty', '1.0',
      '--metrics', '--offline',
      ...(model.mtp > 0 ? ['--spec-type', 'draft-mtp', '--spec-draft-n-max', String(model.mtp)] : []),
      '--api-key-file', '/proc/self/fd/3', '--no-cors-credentials',
    ];
  }

  async #waitForHealth(generation: number): Promise<void> {
    const deadline = Date.now() + this.options.healthTimeoutMs;
    while (Date.now() < deadline) {
      this.#assertGeneration(generation);
      try {
        const response = await fetch(`${this.#endpoint()}/health`, { signal: AbortSignal.timeout(Math.min(this.options.pollIntervalMs * 4, 250)) });
        if (response.status === 200) return;
      } catch { /* bounded retry */ }
      await delay(this.options.pollIntervalMs);
    }
    throw new Error('health_timeout');
  }

  async #verifyProps(alias: string, contextSize: number): Promise<void> {
    const response = await fetch(`${this.#endpoint()}/props`, { headers: { authorization: `Bearer ${this.options.inferenceKey}` }, signal: AbortSignal.timeout(this.options.healthTimeoutMs) });
    if (!response.ok) throw new Error('props_validation_failed');
    const props: unknown = await response.json();
    if (!isExpectedProps(props, alias, contextSize)) throw new Error('props_validation_failed');
  }

  async #stopWithEscalation(): Promise<void> {
    const child = this.#child;
    const running = this.#running;
    if (child === undefined) return;
    this.#phase = 'STOPPING';
    if (running !== undefined) this.#assertOwnership(child, running);
    ++this.#generation;
    this.#lastSignal = 'SIGTERM';
    await signalChild(child, 'SIGTERM');
    if (!await waitForExit(child, this.options.stopTimeoutMs)) {
      if (this.#child !== child) return;
      if (running !== undefined) this.#assertOwnership(child, running);
      this.#lastSignal = 'SIGKILL';
      await signalChild(child, 'SIGKILL');
      if (!await waitForExit(child, this.options.stopTimeoutMs)) throw new Error('child_stop_timeout');
    }
    this.#clearCurrent(child, 'UNLOADED');
  }

  async #cleanupFailedStart(generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    if (this.#child === undefined) { this.#phase = 'UNLOADED'; return; }
    await this.#stopWithEscalation();
  }

  #onChildExit(generation: number, child: ChildProcess): void {
    if (generation !== this.#generation || this.#child !== child) return;
    const crashed = this.#phase === 'READY';
    const running = this.#running;
    this.#clearCurrent(child, crashed ? 'FAILED' : 'UNLOADED');
    if (crashed && running !== undefined) this.#observe(() => this.options.telemetry?.addChildCrash(running.model));
    if (crashed && running !== undefined) for (const listener of [...this.#unexpectedExitListeners]) { try { listener(Object.freeze({ child: running })); } catch { /* observer isolation */ } }
  }

  #assertGeneration(generation: number): void {
    if (generation !== this.#generation || this.#child === undefined || this.#running === undefined) throw new Error('child_exited');
  }
  #assertPendingStart(generation: number, pending: PendingStart): void {
    if (generation !== this.#generation || this.#pendingStart !== pending || pending.controller.signal.aborted || this.#child !== undefined || this.#running !== undefined) throw new Error('child_start_cancelled');
  }
  #assertStartingChild(generation: number, child: ChildProcess): void {
    if (generation !== this.#generation || this.#child !== child) throw new Error('child_exited');
  }
  #assertOwnership(child: ChildProcess, running: RunningChild): void {
    if (this.#child !== child || this.#running !== running || child.pid !== running.pid || !this.#isSameProcess(running)) throw new Error('ownership_conflict');
  }
  #clearCurrent(child: ChildProcess, phase: ManagerPhase): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#running = undefined;
    this.#phase = phase;
  }
  #cancelPendingStart(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> | undefined {
    const pending = this.#pendingStart;
    if (pending === undefined) return undefined;
    if (!pending.controller.signal.aborted) {
      this.#phase = 'STOPPING';
      this.#lastSignal = signal;
      ++this.#generation;
      pending.controller.abort();
    }
    return pending.settled;
  }
  #observe(callback: () => void): void { try { callback(); } catch { /* telemetry must not alter child ownership */ } }
  #now(): number { return this.options.now?.() ?? performance.now(); }
  #processStartToken(pid: number): string { return this.options.processStartToken?.(pid) ?? processStartToken(pid); }
  #isSameProcess(running: RunningChild): boolean { try { return this.#processStartToken(running.pid) === running.startToken; } catch { return false; } }
  #endpoint(): string { return `http://${this.#host}:${this.#port}`; }
}

function childEnvironment(inferenceKey: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined && value !== inferenceKey && !/(key|token|secret|credential|password|auth)/i.test(name)) environment[name] = value;
  }
  return environment;
}
function processStartToken(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
  const closeParen = stat.lastIndexOf(')');
  const fieldsAfterComm = closeParen < 0 ? [] : stat.slice(closeParen + 2).split(' ');
  const startToken = fieldsAfterComm[19];
  if (startToken === undefined || startToken.length === 0) throw new Error('child_identity_unavailable');
  return startToken;
}
function matchesDevice(pattern: RegExp, line: string): boolean { return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(line); }
function enumerateDevices(binary: string, environment: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const child = spawn(binary, ['--list-devices'], {
    shell: false,
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const result = Promise.withResolvers<string>();
  const cleaned = Promise.withResolvers<void>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let resultSettled = false;
  let cleanupSettled = false;
  const terminate = () => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* close/error settles cleanup */ } }
  };
  let timer: NodeJS.Timeout;
  const cleanup = () => {
    if (cleanupSettled) return;
    cleanupSettled = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', fail);
    cleaned.resolve();
  };
  const rejectEnumeration = () => {
    if (resultSettled) return;
    resultSettled = true;
    result.reject(new Error('device_enumeration_failed'));
  };
  const fail = () => { terminate(); rejectEnumeration(); };
  timer = setTimeout(fail, timeoutMs);
  timer.unref();
  signal.addEventListener('abort', fail, { once: true });
  if (signal.aborted) fail();
  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (resultSettled) return;
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 64 * 1024) { fail(); return; }
    chunks.push(value);
  });
  child.once('error', () => { rejectEnumeration(); if (child.pid === undefined) cleanup(); });
  child.once('close', (code, closeSignal) => {
    cleanup();
    if (resultSettled) return;
    resultSettled = true;
    if (code !== 0 || closeSignal !== null) result.reject(new Error('device_enumeration_failed'));
    else result.resolve(Buffer.concat(chunks).toString('utf8'));
  });
  return result.promise.finally(() => cleaned.promise);
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true); }); });
}
function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => { child.off('error', onError); resolve(); };
    const onError = () => { child.off('spawn', onSpawn); reject(new Error('child_spawn_failed')); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}
function elapsedSeconds(startedAt: number, endedAt: number): number { return Math.max(0, endedAt - startedAt) / 1_000; }
async function signalChild(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) {
    try { await waitForSpawn(child); } catch { return; }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
function isExpectedProps(value: unknown, alias: string, contextSize: number): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const props = value as { model_alias?: unknown; total_slots?: unknown; default_generation_settings?: { n_ctx?: unknown } };
  return props.model_alias === alias && props.total_slots === 1 && props.default_generation_settings?.n_ctx === contextSize;
}
