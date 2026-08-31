import { randomUUID } from 'node:crypto';
import type { OperationRequest, OperationStatus } from '@local/gpu-workload-core';

export interface ManagedOperationSnapshot {
  readonly id: string;
  readonly request: OperationRequest;
  readonly status: OperationStatus;
  readonly error?: { readonly code: string };
  readonly result?: { readonly activeModel?: string };
}

interface StoredOperation {
  readonly id: string;
  readonly request: OperationRequest;
  status: OperationStatus;
  error?: { readonly code: string };
  result?: { readonly activeModel?: string };
  readonly createdAt: number;
  terminalAt?: number;
  initialResult?: unknown;
}

export interface OperationStoreOptions {
  readonly now?: () => number;
  readonly retentionMs?: number;
  readonly maximumTerminalRecords?: number;
}

export type OperationClaim =
  | { readonly kind: 'created'; readonly operation: ManagedOperationSnapshot }
  | { readonly kind: 'replay'; readonly operation: ManagedOperationSnapshot }
  | { readonly kind: 'conflict' };

export class OperationStore {
  #records = new Map<string, StoredOperation>();
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #maximumTerminalRecords: number;

  constructor(options: OperationStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
    this.#maximumTerminalRecords = options.maximumTerminalRecords ?? 2_048;
  }

  claim(request: OperationRequest): OperationClaim {
    this.prune();
    const found = this.#records.get(request.idempotencyKey);
    if (found !== undefined) return sameRequest(found.request, request)
      ? Object.freeze({ kind: 'replay', operation: snapshot(found) })
      : Object.freeze({ kind: 'conflict' });
    return Object.freeze({ kind: 'created', operation: this.create(request) });
  }

  create(request: OperationRequest): ManagedOperationSnapshot {
    this.prune();
    const existing = this.#records.get(request.idempotencyKey);
    if (existing !== undefined) throw new Error('idempotency_key_exists');
    const operation: StoredOperation = { id: randomUUID(), request: freezeRequest(request), status: 'RUNNING', createdAt: this.#now() };
    this.#records.set(request.idempotencyKey, operation);
    return snapshot(operation);
  }

  get(id: string): ManagedOperationSnapshot | undefined {
    for (const record of this.#records.values()) if (record.id === id) return snapshot(record);
    return undefined;
  }
  getByKey(key: string): ManagedOperationSnapshot | undefined { const found = this.#records.get(key); return found === undefined ? undefined : snapshot(found); }
  initialResult(id: string): unknown { return this.#record(id).initialResult; }
  setInitialResult(id: string, result: unknown): void { this.#record(id).initialResult = result; }
  all(): readonly ManagedOperationSnapshot[] { return Object.freeze([...this.#records.values()].map(snapshot)); }

  setStatus(id: string, status: OperationStatus): ManagedOperationSnapshot {
    const record = this.#record(id);
    record.status = status;
    if (isTerminal(status)) record.terminalAt = this.#now();
    return snapshot(record);
  }
  finish(idOrOperation: string | ManagedOperationSnapshot, status: Extract<OperationStatus, 'COMPLETED' | 'FAILED' | 'CANCELLED'>, error?: { readonly code: string }, result?: { readonly activeModel?: string }): ManagedOperationSnapshot {
    const record = this.#record(typeof idOrOperation === 'string' ? idOrOperation : idOrOperation.id);
    record.status = status;
    record.error = error;
    record.result = result;
    record.terminalAt = this.#now();
    this.prune();
    return snapshot(record);
  }
  prune(): void {
    const now = this.#now();
    for (const [key, record] of this.#records) if (record.terminalAt !== undefined && now - record.terminalAt > this.#retentionMs) this.#records.delete(key);
    const terminal = [...this.#records.entries()].filter(([, record]) => record.terminalAt !== undefined).sort((a, b) => (a[1].terminalAt ?? 0) - (b[1].terminalAt ?? 0));
    while (terminal.length > this.#maximumTerminalRecords) {
      const oldest = terminal.shift();
      if (oldest !== undefined) this.#records.delete(oldest[0]);
    }
  }
  #record(id: string): StoredOperation {
    for (const record of this.#records.values()) if (record.id === id) return record;
    throw new Error('operation_not_found');
  }
}

function isTerminal(status: OperationStatus): boolean { return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED'; }
function sameRequest(left: OperationRequest, right: OperationRequest): boolean { return left.action === right.action && left.model === right.model && left.onBusy === right.onBusy && left.idempotencyKey === right.idempotencyKey; }
function freezeRequest(request: OperationRequest): OperationRequest { return Object.freeze({ ...request }); }
function snapshot(record: StoredOperation): ManagedOperationSnapshot { return Object.freeze({ id: record.id, request: freezeRequest(record.request), status: record.status, ...(record.error === undefined ? {} : { error: Object.freeze({ ...record.error }) }), ...(record.result === undefined ? {} : { result: Object.freeze({ ...record.result }) }) }); }
