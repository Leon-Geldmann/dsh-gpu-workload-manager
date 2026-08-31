import { randomUUID } from 'node:crypto';

export interface RequestLease {
  readonly id: string;
  readonly model: string;
  readonly aborted: boolean;
  bindAbort(callback: () => void): void;
  abort(): void;
  complete(): void;
}

export type AdmissionResult =
  | { readonly kind: 'admitted'; readonly lease: RequestLease }
  | { readonly kind: 'rejected'; readonly code: 'model_transition' | 'local_model_busy' };

export interface RequestRegistryOptions { readonly maximumActive: number; }

/** Tracks only local gateway requests.  Admission and registration are one synchronous mutation. */
export class RequestRegistry {
  #admissionOpen = true;
  #leases = new Map<string, Lease>();
  #idleWaiters = new Set<() => void>();

  constructor(private readonly options: RequestRegistryOptions) {
    if (!Number.isSafeInteger(options.maximumActive) || options.maximumActive < 1) throw new Error('invalid_maximum_active');
  }

  count(): number { return this.#leases.size; }
  admissionOpen(): boolean { return this.#admissionOpen; }

  admit(model: string): AdmissionResult {
    if (!this.#admissionOpen) return Object.freeze({ kind: 'rejected', code: 'model_transition' });
    if (this.#leases.size >= this.options.maximumActive) return Object.freeze({ kind: 'rejected', code: 'local_model_busy' });
    const lease = new Lease(randomUUID(), model, () => this.#remove(lease.id));
    this.#leases.set(lease.id, lease);
    return Object.freeze({ kind: 'admitted', lease });
  }

  /** Atomically deny new work and install an idle waiter for the current set. */
  closeAdmissionAndWhenIdle(): Promise<void> {
    this.#admissionOpen = false;
    if (this.#leases.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  openAdmission(): void { this.#admissionOpen = true; }
  closeAdmission(): void { this.#admissionOpen = false; }

  abortAll(): void {
    // A snapshot makes a re-entrant completion unable to affect traversal.
    for (const lease of [...this.#leases.values()]) lease.abort();
  }

  complete(id: string): void { this.#leases.get(id)?.complete(); }

  shutdown(): void {
    this.#admissionOpen = false;
    this.abortAll();
    this.#resolveIdle();
  }

  #remove(id: string): void {
    if (!this.#leases.delete(id)) return;
    if (this.#leases.size === 0) this.#resolveIdle();
  }

  #resolveIdle(): void {
    const waiters = [...this.#idleWaiters];
    this.#idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}

class Lease implements RequestLease {
  #finalized = false;
  #aborted = false;
  #abort?: () => void;

  constructor(readonly id: string, readonly model: string, private readonly finalize: () => void) {}
  get aborted(): boolean { return this.#aborted; }
  bindAbort(callback: () => void): void { this.#abort = callback; }
  abort(): void {
    if (this.#finalized || this.#aborted) return;
    this.#aborted = true;
    try { this.#abort?.(); } catch { /* teardown must not block other local leases */ } finally { this.complete(); }
  }
  complete(): void {
    if (this.#finalized) return;
    this.#finalized = true;
    this.finalize();
  }
}
