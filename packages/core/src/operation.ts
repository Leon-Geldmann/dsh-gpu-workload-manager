import type { ManagerPhase, ManagerSnapshot, OperationRequest, OperationSnapshot } from './types.js';

const REQUEST_KEYS = new Set(['idempotencyKey', 'action', 'model', 'onBusy']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OperationEvent =
  | { readonly type: 'QUEUE'; readonly operation: OperationSnapshot }
  | { readonly type: 'CLEAR_OPERATION' }
  | { readonly type: 'SET_PHASE'; readonly phase: ManagerPhase }
  | { readonly type: 'SET_ACTIVE_MODEL'; readonly model?: string };

export function parseOperationRequest(value: unknown, catalogIds: ReadonlySet<string>): OperationRequest {
  if (!isRecord(value) || !Object.keys(value).every((key) => REQUEST_KEYS.has(key))) {
    throw new Error('invalid_operation_request');
  }

  const { idempotencyKey, action, model, onBusy } = value;
  if (typeof idempotencyKey !== 'string' || !UUID_PATTERN.test(idempotencyKey)) {
    throw new Error('invalid_idempotency_key');
  }
  if (action !== 'load' && action !== 'switch' && action !== 'unload') {
    throw new Error('invalid_operation_action');
  }
  if (onBusy !== 'reject' && onBusy !== 'queue' && onBusy !== 'force') {
    throw new Error('invalid_busy_policy');
  }

  if (action === 'unload') {
    if (model !== undefined) throw new Error('unload_model_forbidden');
    return Object.freeze({ idempotencyKey, action, onBusy });
  }
  if (typeof model !== 'string' || !catalogIds.has(model)) {
    throw new Error('invalid_model_id');
  }
  return Object.freeze({ idempotencyKey, action, model, onBusy });
}

export function operationReducer(snapshot: ManagerSnapshot, event: OperationEvent): ManagerSnapshot {
  switch (event.type) {
    case 'QUEUE':
      if (snapshot.activeOperation !== undefined) throw new Error('operation_in_progress');
      return freezeSnapshot({ ...snapshot, activeOperation: freezeOperation(event.operation) });
    case 'CLEAR_OPERATION':
      return freezeSnapshot({ ...snapshot, activeOperation: undefined });
    case 'SET_PHASE':
      return freezeSnapshot({ ...snapshot, phase: event.phase });
    case 'SET_ACTIVE_MODEL':
      return freezeSnapshot({ ...snapshot, activeModel: event.model });
  }
}

function freezeSnapshot(snapshot: ManagerSnapshot): ManagerSnapshot {
  return Object.freeze(snapshot);
}

function freezeOperation(operation: OperationSnapshot): OperationSnapshot {
  return Object.freeze({ ...operation, request: Object.freeze({ ...operation.request }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
