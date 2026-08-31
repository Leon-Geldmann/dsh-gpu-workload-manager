import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { credentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials';
import type { ResolvedPluginConfig } from './config.js';
import { LOCAL_MODEL_IDS } from './commands.js';
import type { BusyPolicy, GpuCancelResult, GpuManagerStatus, GpuModel, GpuModelList, GpuOperation, GpuOperationRequest, GpuSubmitResult, LocalModelId, ManagerPhase, OperationStatus } from './types.js';

export type { BusyPolicy, GpuCancelResult, GpuManagerStatus, GpuModel, GpuModelList, GpuOperation, GpuOperationRequest, GpuSubmitResult, ManagerPhase, OperationAction, OperationStatus } from './types.js';

export type ManagerClientErrorCode = 'aborted' | 'credential_unavailable' | 'invalid_request' | 'invalid_response' | 'timeout' | 'unauthorized' | 'unavailable';

const ERROR_MESSAGES: Readonly<Record<ManagerClientErrorCode, string>> = Object.freeze({
  aborted: 'GPU Workload Manager 操作已取消',
  credential_unavailable: 'GPU Workload Manager 凭证未配置',
  invalid_request: 'GPU Workload Manager 请求无效',
  invalid_response: 'GPU Workload Manager 返回了无效响应',
  timeout: 'GPU Workload Manager 请求超时',
  unauthorized: 'GPU Workload Manager 鉴权失败',
  unavailable: 'GPU Workload Manager 暂不可用',
});

export class ManagerClientError extends Error {
  readonly code: ManagerClientErrorCode;
  constructor(code: ManagerClientErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ManagerClientError';
    this.code = code;
  }
}

export interface CredentialResolver {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<ResolvedCredential | undefined>;
}

export interface ManagerClientOptions {
  readonly timeoutMs?: number;
  readonly responseBodyLimit?: number;
}

interface RawResponse { readonly status: number; readonly body: unknown; }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MANAGEMENT_KEY = /^[0-9a-f]{64}$/i;
const MODEL_IDS = new Set<string>(LOCAL_MODEL_IDS);
const PHASES = new Set<string>(['UNLOADED', 'STARTING', 'WARMING', 'READY', 'DRAINING', 'FORCING', 'STOPPING', 'FAILED', 'DEGRADED_UNLOADED']);
const OPERATION_STATUSES = new Set<string>(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);

export class ManagerClient {
  readonly #endpoint: URL;
  readonly #credentialReference: string;
  readonly #credentials: CredentialResolver;
  readonly #timeoutMs: number;
  readonly #responseBodyLimit: number;

  constructor(config: ResolvedPluginConfig, credentials: CredentialResolver, options: ManagerClientOptions = {}) {
    this.#endpoint = new URL(config.managerUrl);
    this.#credentialReference = config.managementCredentialRef;
    this.#credentials = credentials;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#responseBodyLimit = options.responseBodyLimit ?? 256 * 1024;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || !Number.isSafeInteger(this.#responseBodyLimit) || this.#responseBodyLimit < 1) {
      throw new Error('invalid_manager_client_options');
    }
  }

  async status(signal: AbortSignal): Promise<GpuManagerStatus> {
    const response = await this.#request('GET', '/gpu/v1/status', undefined, signal);
    if (response.status !== 200) throw this.#statusError(response.status);
    return parseStatus(response.body);
  }

  async models(signal: AbortSignal): Promise<GpuModelList> {
    const response = await this.#request('GET', '/gpu/v1/models', undefined, signal);
    if (response.status !== 200) throw this.#statusError(response.status);
    return parseModels(response.body);
  }

  async submit(value: GpuOperationRequest, signal: AbortSignal): Promise<GpuSubmitResult> {
    const operation = parseOperationRequest(value);
    const response = await this.#request('POST', '/gpu/v1/operations', operation, signal);
    if (response.status === 200 || response.status === 202) {
      return Object.freeze({ kind: 'accepted', operation: parseOperationEnvelope(response.body) });
    }
    if (response.status === 409) return parseSubmitConflict(response.body);
    throw this.#statusError(response.status);
  }

  async cancel(operationId: string, signal: AbortSignal): Promise<GpuCancelResult> {
    if (!UUID.test(operationId)) throw new ManagerClientError('invalid_request');
    const response = await this.#request('DELETE', `/gpu/v1/operations/${operationId}`, undefined, signal);
    if (response.status === 200) return Object.freeze({ kind: 'cancelled', operation: parseOperationEnvelope(response.body) });
    if (response.status === 409) return parseCancelConflict(response.body);
    throw this.#statusError(response.status);
  }

  async #request(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, signal: AbortSignal): Promise<RawResponse> {
    const managementKey = await this.#resolveManagementKey(signal);
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: IncomingHttpHeaders = {
      accept: 'application/json',
      authorization: `Bearer ${managementKey}`,
      connection: 'close',
      ...(encoded === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(encoded.length) }),
    };
    const options: RequestOptions = {
      protocol: 'http:', hostname: this.#endpoint.hostname, port: this.#endpoint.port,
      method, path, headers, agent: false,
    };
    return await new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: RawResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal.removeEventListener('abort', abort);
        if (error === undefined) resolve(value!);
        else reject(error instanceof ManagerClientError ? error : new ManagerClientError('unavailable'));
      };
      const client = httpRequest(options, (response) => {
        const status = response.statusCode ?? 0;
        const contentType = response.headers['content-type'];
        if (status < 200 || status > 599 || (status >= 300 && status < 400) || typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=(?:utf-8|utf8))?$/i.test(contentType)) {
          response.destroy();
          finish(new ManagerClientError('invalid_response'));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += value.length;
          if (bytes > this.#responseBodyLimit) {
            response.destroy();
            finish(new ManagerClientError('invalid_response'));
            return;
          }
          chunks.push(value);
        });
        response.once('error', (error) => finish(error));
        response.once('end', () => {
          let parsed: unknown;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { finish(new ManagerClientError('invalid_response')); return; }
          finish(undefined, { status, body: parsed });
        });
      });
      const deadline = setTimeout(() => client.destroy(new ManagerClientError('timeout')), this.#timeoutMs);
      deadline.unref();
      const abort = () => client.destroy(new ManagerClientError('aborted'));
      signal.addEventListener('abort', abort, { once: true });
      client.once('error', (error) => finish(error));
      if (signal.aborted) { abort(); return; }
      client.end(encoded);
    });
  }

  async #resolveManagementKey(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new ManagerClientError('aborted');
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error: ManagerClientError | undefined, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal.removeEventListener('abort', abort);
        if (error === undefined) resolve(value!);
        else reject(error);
      };
      const deadline = setTimeout(() => finish(new ManagerClientError('timeout')), this.#timeoutMs);
      deadline.unref();
      const abort = () => finish(new ManagerClientError('aborted'));
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => this.#credentials.resolve(credentialRef(this.#credentialReference)))
        .then(
          (credential) => credential !== undefined && MANAGEMENT_KEY.test(credential.value)
            ? finish(undefined, credential.value)
            : finish(new ManagerClientError('credential_unavailable')),
          () => finish(new ManagerClientError('credential_unavailable')),
        );
    });
  }

  #statusError(status: number): ManagerClientError {
    return new ManagerClientError(status === 401 ? 'unauthorized' : status >= 500 ? 'unavailable' : 'invalid_response');
  }
}

function parseStatus(value: unknown): GpuManagerStatus {
  if (!isRecord(value) || !hasOnlyKeys(value, ['phase', 'activeModel', 'activeRequestCount', 'target', 'activeOperation']) || typeof value.phase !== 'string' || !PHASES.has(value.phase) || !isNonNegativeInteger(value.activeRequestCount)) invalidResponse();
  const activeModel = parseOptionalModel(value.activeModel);
  const target = parseOptionalModel(value.target);
  const activeOperation = value.activeOperation === undefined ? undefined : parseOperation(value.activeOperation);
  return Object.freeze({ phase: value.phase as ManagerPhase, ...(activeModel === undefined ? {} : { activeModel }), activeRequestCount: value.activeRequestCount as number, ...(target === undefined ? {} : { target }), ...(activeOperation === undefined ? {} : { activeOperation }) });
}

function parseModels(value: unknown): GpuModelList {
  if (!isRecord(value) || !hasOnlyKeys(value, ['object', 'data']) || value.object !== 'list' || !Array.isArray(value.data)) invalidResponse();
  const seen = new Set<string>();
  const data = value.data.map((candidate) => {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['id', 'object', 'status']) || candidate.object !== 'model' || typeof candidate.id !== 'string' || !MODEL_IDS.has(candidate.id) || seen.has(candidate.id) || !isRecord(candidate.status) || !hasOnlyKeys(candidate.status, ['value']) || (candidate.status.value !== 'loaded' && candidate.status.value !== 'loading' && candidate.status.value !== 'unloaded')) invalidResponse();
    seen.add(candidate.id as string);
    return Object.freeze({ id: candidate.id as LocalModelId, object: 'model' as const, status: Object.freeze({ value: candidate.status.value as GpuModel['status']['value'] }) });
  });
  if (data.length !== LOCAL_MODEL_IDS.length) invalidResponse();
  return Object.freeze({ object: 'list', data: Object.freeze(data) });
}

function parseOperationRequest(value: unknown): GpuOperationRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['idempotencyKey', 'action', 'model', 'onBusy']) || typeof value.idempotencyKey !== 'string' || !UUID.test(value.idempotencyKey) || (value.action !== 'load' && value.action !== 'switch' && value.action !== 'unload') || (value.onBusy !== 'reject' && value.onBusy !== 'queue' && value.onBusy !== 'force')) invalidRequest();
  if (value.action === 'unload') {
    if (value.model !== undefined) invalidRequest();
    return Object.freeze({ idempotencyKey: value.idempotencyKey as string, action: 'unload', onBusy: value.onBusy as BusyPolicy });
  }
  if (typeof value.model !== 'string' || !MODEL_IDS.has(value.model)) invalidRequest();
  return Object.freeze({ idempotencyKey: value.idempotencyKey as string, action: value.action as 'load' | 'switch', model: value.model as LocalModelId, onBusy: value.onBusy as BusyPolicy });
}

function parseOperationEnvelope(value: unknown): GpuOperation {
  if (!isRecord(value) || !hasOnlyKeys(value, ['operation'])) invalidResponse();
  return parseOperation(value.operation);
}

function parseOperation(value: unknown): GpuOperation {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'request', 'status', 'error', 'result']) || typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.status !== 'string' || !OPERATION_STATUSES.has(value.status)) invalidResponse();
  let request: GpuOperationRequest;
  try { request = parseOperationRequest(value.request); } catch { invalidResponse(); }
  const error = value.error === undefined ? undefined : parseOperationError(value.error);
  const result = value.result === undefined ? undefined : parseOperationResult(value.result);
  return Object.freeze({ id: value.id, request: request!, status: value.status as OperationStatus, ...(error === undefined ? {} : { error }), ...(result === undefined ? {} : { result }) });
}

function parseOperationError(value: unknown): { readonly code: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, ['code']) || typeof value.code !== 'string' || value.code.length === 0) invalidResponse();
  return Object.freeze({ code: value.code as string });
}

function parseOperationResult(value: unknown): { readonly activeModel?: LocalModelId } {
  if (!isRecord(value) || !hasOnlyKeys(value, ['activeModel'])) invalidResponse();
  const activeModel = parseOptionalModel(value.activeModel);
  return Object.freeze(activeModel === undefined ? {} : { activeModel });
}

function parseSubmitConflict(value: unknown): GpuSubmitResult {
  const error = parseErrorEnvelope(value);
  if (error.code === 'local_model_busy') {
    if (!isNonNegativeInteger(error.activeRequestCount)) invalidResponse();
    const activeModel = parseOptionalModel(error.activeModel);
    const targetModel = parseOptionalModel(error.targetModel);
    return Object.freeze({ kind: 'busy', code: 'local_model_busy', activeRequestCount: error.activeRequestCount as number, ...(activeModel === undefined ? {} : { activeModel }), ...(targetModel === undefined ? {} : { targetModel }) });
  }
  if (error.code === 'idempotency_conflict' || error.code === 'operation_in_progress') return Object.freeze({ kind: 'conflict', code: error.code });
  return invalidResponse();
}

function parseCancelConflict(value: unknown): GpuCancelResult {
  const error = parseErrorEnvelope(value);
  if (error.code === 'operation_not_cancellable' || error.code === 'operation_not_found') return Object.freeze({ kind: 'conflict', code: error.code });
  return invalidResponse();
}

function parseErrorEnvelope(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['error']) || !isRecord(value.error) || typeof value.error.code !== 'string') invalidResponse();
  return value.error as Record<string, unknown>;
}

function parseOptionalModel(value: unknown): LocalModelId | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !MODEL_IDS.has(value)) invalidResponse();
  return value as LocalModelId;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function invalidRequest(): never { throw new ManagerClientError('invalid_request'); }
function invalidResponse(): never { throw new ManagerClientError('invalid_response'); }
