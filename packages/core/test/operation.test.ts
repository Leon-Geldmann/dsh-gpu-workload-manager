import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseOperationRequest, operationReducer } from '../src/operation.js';
import type { ManagerSnapshot, OperationSnapshot } from '../src/types.js';

const catalogIds = new Set(['qwen3.8-27b', 'qwen3.8-27b-q4']);
const operation: OperationSnapshot = {
  id: randomUUID(),
  request: { action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'queue', idempotencyKey: randomUUID() },
  status: 'QUEUED'
};
const initialSnapshot: ManagerSnapshot = { phase: 'READY', activeModel: 'qwen3.8-27b', activeOperation: undefined };

describe('parseOperationRequest', () => {
  it('rejects paths and unknown model ids from operation input', () => {
    expect(() => parseOperationRequest({ action: 'load', model: '/tmp/x.gguf', onBusy: 'reject', idempotencyKey: randomUUID() }, catalogIds)).toThrow();
    expect(() => parseOperationRequest({ action: 'load', model: 'not-a-model', onBusy: 'reject', idempotencyKey: randomUUID() }, catalogIds)).toThrow();
  });

  it('rejects malformed requests and accepts a catalog-backed switch', () => {
    expect(() => parseOperationRequest(null, catalogIds)).toThrow();
    expect(() => parseOperationRequest({ action: 'load', onBusy: 'reject', idempotencyKey: randomUUID() }, catalogIds)).toThrow();
    expect(() => parseOperationRequest({ action: 'unload', model: 'qwen3.8-27b', onBusy: 'reject', idempotencyKey: randomUUID() }, catalogIds)).toThrow();
    expect(() => parseOperationRequest({ action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'queue', idempotencyKey: 'nope', extra: true }, catalogIds)).toThrow();
    expect(parseOperationRequest({ action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'queue', idempotencyKey: randomUUID() }, catalogIds)).toMatchObject({ action: 'switch', model: 'qwen3.8-27b-q4' });
  });
});

describe('operationReducer', () => {
  it('allows only one transition operation at a time', () => {
    const queued = operationReducer(initialSnapshot, { type: 'QUEUE', operation });
    const other: OperationSnapshot = { ...operation, id: randomUUID(), request: { ...operation.request, idempotencyKey: randomUUID() } };
    expect(() => operationReducer(queued, { type: 'QUEUE', operation: other })).toThrowError(/operation_in_progress/);
  });

  it('returns a new immutable snapshot when the queued operation is cleared', () => {
    const queued = operationReducer(initialSnapshot, { type: 'QUEUE', operation });
    const cleared = operationReducer(queued, { type: 'CLEAR_OPERATION' });
    expect(cleared).toEqual({ ...initialSnapshot, activeOperation: undefined });
    expect(cleared).not.toBe(queued);
  });
});
