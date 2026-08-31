import type { ManagerPhase } from '@local/gpu-workload-core';
import type { EngineSnapshot } from './manager-engine.js';

export interface InferenceMetricObservation {
  firstGeneratedToken(): void;
  end(): void;
}

export interface WorkloadTelemetry {
  observeChildLoadToHealth(model: string, seconds: number): void;
  observeChildWarmup(model: string, seconds: number): void;
  observeQueueWait(model: string, seconds: number): void;
  addForceCancellations(model: string, count: number): void;
  addChildCrash(model: string): void;
}

const PHASES: readonly ManagerPhase[] = [
  'UNLOADED', 'STARTING', 'WARMING', 'READY', 'DRAINING',
  'FORCING', 'STOPPING', 'FAILED', 'DEGRADED_UNLOADED',
];
const BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1_200] as const;

export class Metrics implements WorkloadTelemetry {
  #requests = 0;
  #active = 0;
  readonly #models: readonly string[];
  readonly #modelSet: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #loadToHealth = new Map<string, Histogram>();
  readonly #warmup = new Map<string, Histogram>();
  readonly #ttft = new Map<string, Histogram>();
  readonly #requestDuration = new Map<string, Histogram>();
  readonly #queueWait = new Map<string, Histogram>();
  readonly #forceCancellations = new Map<string, number>();
  readonly #childCrashes = new Map<string, number>();

  constructor(catalogModels: readonly string[] = [], now: () => number = monotonicMilliseconds) {
    if (new Set(catalogModels).size !== catalogModels.length || catalogModels.some((model) => model.length === 0)) throw new Error('invalid_metrics_catalog');
    this.#models = Object.freeze([...catalogModels]);
    this.#modelSet = new Set(this.#models);
    this.#now = now;
    for (const model of this.#models) {
      this.#loadToHealth.set(model, new Histogram());
      this.#warmup.set(model, new Histogram());
      this.#ttft.set(model, new Histogram());
      this.#requestDuration.set(model, new Histogram());
      this.#queueWait.set(model, new Histogram());
      this.#forceCancellations.set(model, 0);
      this.#childCrashes.set(model, 0);
    }
  }

  /** Compatibility for callers which only need the aggregate gateway gauges. */
  begin(): void { this.#requests += 1; this.#active += 1; }
  /** Compatibility for callers which only need the aggregate gateway gauges. */
  end(): void { this.#active = Math.max(0, this.#active - 1); }

  beginInference(model: string): InferenceMetricObservation {
    this.begin();
    const startedAt = this.#now();
    let firstTokenSeen = false;
    let ended = false;
    return Object.freeze({
      firstGeneratedToken: () => {
        if (firstTokenSeen || ended) return;
        firstTokenSeen = true;
        this.#observe(this.#ttft, model, elapsedSeconds(startedAt, this.#now()));
      },
      end: () => {
        if (ended) return;
        ended = true;
        this.end();
        this.#observe(this.#requestDuration, model, elapsedSeconds(startedAt, this.#now()));
      },
    });
  }

  observeChildLoadToHealth(model: string, seconds: number): void { this.#observe(this.#loadToHealth, model, seconds); }
  observeChildWarmup(model: string, seconds: number): void { this.#observe(this.#warmup, model, seconds); }
  observeQueueWait(model: string, seconds: number): void { this.#observe(this.#queueWait, model, seconds); }
  addForceCancellations(model: string, count: number): void {
    if (!this.#modelSet.has(model) || !Number.isSafeInteger(count) || count < 1) return;
    this.#forceCancellations.set(model, this.#forceCancellations.get(model)! + count);
  }
  addChildCrash(model: string): void {
    if (!this.#modelSet.has(model)) return;
    this.#childCrashes.set(model, this.#childCrashes.get(model)! + 1);
  }

  render(snapshot: EngineSnapshot): string {
    const lines = [
      `manager_gateway_requests_total ${this.#requests}`,
      `manager_gateway_active_requests ${this.#active}`,
      `manager_engine_active_requests ${snapshot.activeRequestCount}`,
    ];
    for (const phase of PHASES) lines.push(`manager_engine_phase{phase="${phase}"} ${snapshot.phase === phase ? 1 : 0}`);
    this.#renderHistogram(lines, 'manager_child_load_to_health_seconds', this.#loadToHealth);
    this.#renderHistogram(lines, 'manager_child_warmup_seconds', this.#warmup);
    this.#renderHistogram(lines, 'manager_inference_ttft_seconds', this.#ttft);
    this.#renderHistogram(lines, 'manager_inference_request_duration_seconds', this.#requestDuration);
    this.#renderHistogram(lines, 'manager_queue_wait_seconds', this.#queueWait);
    for (const model of this.#models) lines.push(`manager_force_cancellations_total{model="${escapeLabel(model)}"} ${this.#forceCancellations.get(model)!}`);
    for (const model of this.#models) lines.push(`manager_child_crashes_total{model="${escapeLabel(model)}"} ${this.#childCrashes.get(model)!}`);
    return `${lines.join('\n')}\n`;
  }

  #observe(histograms: ReadonlyMap<string, Histogram>, model: string, seconds: number): void {
    if (!this.#modelSet.has(model) || !Number.isFinite(seconds) || seconds < 0) return;
    histograms.get(model)!.observe(seconds);
  }
  #renderHistogram(lines: string[], name: string, histograms: ReadonlyMap<string, Histogram>): void {
    for (const model of this.#models) histograms.get(model)!.render(lines, name, model);
  }
}

class Histogram {
  #count = 0;
  #sum = 0;
  readonly #bucketCounts = BUCKETS.map(() => 0);

  observe(value: number): void {
    this.#count += 1;
    this.#sum += value;
    for (let index = 0; index < BUCKETS.length; index += 1) if (value <= BUCKETS[index]!) this.#bucketCounts[index]! += 1;
  }

  render(lines: string[], name: string, model: string): void {
    const label = escapeLabel(model);
    for (let index = 0; index < BUCKETS.length; index += 1) lines.push(`${name}_bucket{model="${label}",le="${BUCKETS[index]}"} ${this.#bucketCounts[index]}`);
    lines.push(`${name}_bucket{model="${label}",le="+Inf"} ${this.#count}`);
    lines.push(`${name}_sum{model="${label}"} ${this.#sum}`);
    lines.push(`${name}_count{model="${label}"} ${this.#count}`);
  }
}

function monotonicMilliseconds(): number { return performance.now(); }
function elapsedSeconds(startedAt: number, endedAt: number): number { return Math.max(0, endedAt - startedAt) / 1_000; }
function escapeLabel(value: string): string { return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"'); }
