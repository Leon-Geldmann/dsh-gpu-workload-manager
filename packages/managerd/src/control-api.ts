import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseOperationRequest } from '@local/gpu-workload-core';
import type { ManagerEngine, SubmitResult } from './manager-engine.js';
import { closeJsonError, json, jsonError } from './http-errors.js';

export async function handleControl(request: IncomingMessage, response: ServerResponse, engine: ManagerEngine, catalogIds: readonly string[], bodyLimit: number): Promise<void> {
  const path = request.url!;
  if (request.method === 'GET' && path === '/gpu/v1/status') return json(response, 200, statusBody(engine.snapshot()));
  if (request.method === 'GET' && path === '/gpu/v1/models') return json(response, 200, modelsBody(engine.snapshot(), catalogIds));
  if (request.method === 'POST' && path === '/gpu/v1/operations') {
    const body = await readJson(request, bodyLimit);
    if (body.kind === 'error') return closeJsonError(response, body.status, body.code);
    let operation;
    try { operation = parseOperationRequest(body.value, new Set(catalogIds)); } catch { return jsonError(response, 400, 'invalid_operation_request'); }
    return sendSubmit(response, await engine.submit(operation, 'http'));
  }
  const operationId = /^\/gpu\/v1\/operations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(path)?.[1];
  if (operationId !== undefined && request.method === 'GET') {
    const operation = engine.operations().find((candidate) => candidate.id === operationId);
    return operation === undefined ? jsonError(response, 404, 'operation_not_found') : json(response, 200, { operation });
  }
  if (operationId !== undefined && request.method === 'DELETE') {
    const result = engine.cancel(operationId);
    return result.kind === 'cancelled' ? json(response, 200, { operation: result.operation }) : jsonError(response, 409, result.code);
  }
  return jsonError(response, 404, 'not_found');
}

export function modelsBody(snapshot: ReturnType<ManagerEngine['snapshot']>, catalogIds: readonly string[]): object {
  return { object: 'list', data: catalogIds.map((id) => ({ id, object: 'model', status: { value: snapshot.phase === 'READY' && snapshot.activeModel === id ? 'loaded' : snapshot.target === id ? 'loading' : 'unloaded' } })) };
}
export function statusBody(snapshot: ReturnType<ManagerEngine['snapshot']>): object {
  return { phase: snapshot.phase, activeModel: snapshot.activeModel, activeRequestCount: snapshot.activeRequestCount, target: snapshot.target, activeOperation: snapshot.activeOperation };
}

function sendSubmit(response: ServerResponse, result: SubmitResult): void {
  if (result.kind === 'accepted' || result.kind === 'noop') return json(response, result.kind === 'accepted' ? 202 : 200, { operation: result.operation });
  if (result.kind === 'busy') return jsonError(response, 409, 'local_model_busy', { activeRequestCount: result.activeRequestCount, ...(result.activeModel === undefined ? {} : { activeModel: result.activeModel }), ...(result.target === undefined ? {} : { targetModel: result.target }) });
  if (result.kind === 'conflict') return jsonError(response, 409, result.code);
  if (result.kind === 'unavailable') return jsonError(response, 503, result.code);
  return jsonError(response, 500, 'internal_error');
}

export type ReadJsonResult = { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'error'; readonly status: 400 | 413; readonly code: string };
export async function readJson(request: IncomingMessage, limit: number): Promise<ReadJsonResult> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && !/^\d+$/.test(declared)) { request.pause(); return { kind: 'error', status: 400, code: 'invalid_json' }; }
  if (declared !== undefined && Number(declared) > limit) { request.pause(); return { kind: 'error', status: 413, code: 'request_too_large' }; }
  let bytes = 0; const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.length; if (bytes > limit) { request.destroy(); return { kind: 'error', status: 413, code: 'request_too_large' }; } chunks.push(value); }
    return { kind: 'value', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch { return { kind: 'error', status: 400, code: 'invalid_json' }; }
}
