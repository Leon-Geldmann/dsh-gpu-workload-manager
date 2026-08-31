import { request as childRequest } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ManagerEngine } from './manager-engine.js';
import type { ValidatedManagerServerConfig } from './config.js';
import { closeJsonError, jsonError } from './http-errors.js';
import { readJson } from './control-api.js';
import type { Metrics } from './metrics.js';

export type ChildRequestFactory = typeof childRequest;
export async function proxyInference(request: IncomingMessage, response: ServerResponse, engine: ManagerEngine, config: ValidatedManagerServerConfig, metrics: Metrics, requestFactory: ChildRequestFactory = childRequest): Promise<void> {
  const initial = engine.snapshot();
  if (initial.phase !== 'READY' || initial.activeModel === undefined) {
    request.pause();
    if (initial.phase !== 'UNLOADED') response.setHeader('retry-after', String(config.limits.retryAfterSeconds));
    return closeJsonError(response, 503, initial.phase === 'UNLOADED' ? 'model_not_loaded' : 'model_transition');
  }
  const residentModel = initial.activeModel;
  const admitted = engine.admitInference(residentModel);
  if (admitted.kind === 'rejected') {
    request.pause();
    const snapshot = engine.snapshot();
    if (snapshot.phase === 'UNLOADED') return closeJsonError(response, 503, 'model_not_loaded');
    if (snapshot.phase !== 'READY') { response.setHeader('retry-after', String(config.limits.retryAfterSeconds)); return closeJsonError(response, 503, 'model_transition'); }
    return closeJsonError(response, 409, admitted.code);
  }
  const { lease } = admitted; const controller = new AbortController(); let upstream: ReturnType<typeof childRequest> | undefined;
  const observation = metrics.beginInference(residentModel);
  let finalized = false; let totalTimer: NodeJS.Timeout | undefined; let idleTimer: NodeJS.Timeout | undefined; let headersTimer: NodeJS.Timeout | undefined;
  const finish = (abort = false) => {
    if (finalized) return; finalized = true;
    if (totalTimer !== undefined) clearTimeout(totalTimer); if (idleTimer !== undefined) clearTimeout(idleTimer); if (headersTimer !== undefined) clearTimeout(headersTimer);
    if (abort) { controller.abort(); upstream?.destroy(); if (!request.destroyed) request.destroy(); if (!response.destroyed) response.destroy(); }
    lease.complete(); observation.end();
  };
  lease.bindAbort(() => finish(true));
  request.once('aborted', () => finish(true));
  response.once('close', () => { if (!response.writableEnded) finish(true); });
  totalTimer = setTimeout(() => finish(true), config.limits.totalRequestTimeoutMs); totalTimer.unref();
  try {
    const input = await readJson(request, config.limits.inferenceBodyBytes);
    if (finalized) return;
    if (input.kind === 'error') return closeJsonError(response, input.status, input.code);
    if (!isRecord(input.value) || !Object.hasOwn(input.value, 'model') || typeof input.value.model !== 'string') return jsonError(response, 400, 'invalid_model');
    if (!config.catalogIds.includes(input.value.model)) return jsonError(response, 404, 'unknown_model');
    if (input.value.model !== residentModel) return jsonError(response, 409, 'model_not_resident');
    const body = JSON.stringify(input.value);
    const endpoint = new URL(config.childEndpoint);
    const headers: Record<string, string> = { host: '127.0.0.1:18080', authorization: `Bearer ${config.inferenceKey}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
    const requestId = request.headers['x-request-id']; if (typeof requestId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(requestId)) headers['x-request-id'] = requestId;
    upstream = requestFactory({ protocol: endpoint.protocol, host: endpoint.hostname, port: Number(endpoint.port), method: 'POST', path: request.url, headers, agent: false, signal: controller.signal });
    headersTimer = setTimeout(() => upstream?.destroy(new Error('child_headers_timeout')), config.limits.childConnectHeadersTimeoutMs); headersTimer.unref();
    const child = await new Promise<IncomingMessage>((resolve, reject) => { upstream!.once('response', resolve); upstream!.once('error', reject); upstream!.end(body); });
    clearTimeout(headersTimer); headersTimer = undefined;
    if ((child.statusCode ?? 502) < 200 || (child.statusCode ?? 502) >= 300) { child.destroy(); return jsonError(response, 502, 'upstream_unavailable'); }
    for (const [name, value] of safeResponseHeaders(child)) response.setHeader(name, value);
    response.statusCode = child.statusCode ?? 502;
    const resetIdle = () => { if (idleTimer !== undefined) clearTimeout(idleTimer); idleTimer = setTimeout(() => finish(true), config.limits.streamIdleTimeoutMs); idleTimer.unref(); };
    resetIdle();
    const detector = isEventStream(child) ? new SseGeneratedTokenDetector(request.url!, () => observation.firstGeneratedToken()) : undefined;
    const progress = new Transform({
      transform(chunk, _encoding, callback) { detector?.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); resetIdle(); callback(null, chunk); },
      flush(callback) { detector?.end(); callback(); },
    });
    await pipeline(child, progress, response, { signal: controller.signal });
  } catch {
    if (!response.headersSent && !response.destroyed) jsonError(response, 502, 'upstream_unavailable');
  } finally { finish(); }
}

function safeResponseHeaders(child: IncomingMessage): Array<[string, string]> {
  const nominated = new Set<string>();
  for (let i = 0; i < child.rawHeaders.length; i += 2) if (child.rawHeaders[i].toLowerCase() === 'connection') for (const token of child.rawHeaders[i + 1].split(',')) nominated.add(token.trim().toLowerCase());
  const allowed = new Set(['content-type', 'cache-control', 'content-encoding', 'x-request-id']); const output: Array<[string, string]> = [];
  for (let i = 0; i < child.rawHeaders.length; i += 2) { const name = child.rawHeaders[i].toLowerCase(); const value = child.rawHeaders[i + 1]; if (allowed.has(name) && !nominated.has(name) && /^[\x20-\x7e]{0,512}$/.test(value)) output.push([name, value]); }
  return output;
}

const MAX_SSE_EVENT_CHARACTERS = 64 * 1024;

class SseGeneratedTokenDetector {
  readonly #decoder = new StringDecoder('utf8');
  #line = '';
  #dataLines: string[] = [];
  #eventCharacters = 0;
  #discardingEvent = false;
  #droppedLine = false;
  #streamStarted = false;
  #seen = false;

  constructor(private readonly path: string, private readonly observe: () => void) {}

  push(chunk: Buffer): void { if (!this.#seen) this.#consume(this.#decode(this.#decoder.write(chunk)), false); }
  end(): void {
    if (this.#seen) return;
    this.#consume(this.#decode(this.#decoder.end()), true);
    // SSE dispatches only on an explicit blank line; a pending event at EOF is discarded.
    this.#resetEvent();
    this.#line = '';
    this.#droppedLine = false;
  }

  #decode(decoded: string): string {
    if (decoded.length === 0 || this.#streamStarted) return decoded;
    this.#streamStarted = true;
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  }

  #consume(decoded: string, ending: boolean): void {
    if (this.#seen || (decoded.length === 0 && !ending)) return;
    this.#line += decoded;
    while (true) {
      const index = this.#line.search(/[\r\n]/);
      if (index < 0 || (!ending && this.#line[index] === '\r' && index + 1 === this.#line.length)) break;
      const width = this.#line[index] === '\r' && this.#line[index + 1] === '\n' ? 2 : 1;
      const line = this.#line.slice(0, index);
      this.#line = this.#line.slice(index + width);
      if (this.#droppedLine) this.#droppedLine = false;
      else this.#processLine(line);
      if (this.#seen) { this.#line = ''; return; }
    }
    const trailingCarriageReturn = !ending && this.#line.endsWith('\r');
    const pendingCharacters = this.#line.length - (trailingCarriageReturn ? 1 : 0);
    if (pendingCharacters > 0 && (this.#discardingEvent || this.#eventCharacters + pendingCharacters > MAX_SSE_EVENT_CHARACTERS)) {
      this.#discardingEvent = true;
      this.#dataLines = [];
      this.#droppedLine = true;
      this.#line = trailingCarriageReturn ? '\r' : '';
    }
  }

  #processLine(line: string): void {
    if (line.length === 0) {
      if (!this.#discardingEvent) this.#inspect(this.#dataLines.join('\n'));
      this.#resetEvent();
      return;
    }
    if (this.#discardingEvent) return;
    this.#eventCharacters += line.length;
    if (this.#eventCharacters > MAX_SSE_EVENT_CHARACTERS) {
      this.#discardingEvent = true;
      this.#dataLines = [];
      return;
    }
    if (line === 'data') this.#dataLines.push('');
    else if (line.startsWith('data:')) this.#dataLines.push(line.slice(5).replace(/^ /, ''));
  }

  #resetEvent(): void {
    this.#dataLines = [];
    this.#eventCharacters = 0;
    this.#discardingEvent = false;
  }

  #inspect(data: string): void {
    if (data.length === 0 || data.trim() === '[DONE]') return;
    let value: unknown;
    try { value = JSON.parse(data); } catch { return; }
    if (!hasGeneratedToken(this.path, value)) return;
    this.#seen = true; this.observe();
  }
}
function isEventStream(child: IncomingMessage): boolean {
  const value = child.headers['content-type'];
  return typeof value === 'string' && /^text\/event-stream(?:\s*;|$)/i.test(value);
}
function hasGeneratedToken(path: string, value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (path === '/v1/chat/completions') return choices(value).some((choice) => {
    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    return delta !== undefined && ([delta.content, delta.reasoning_content, delta.reasoning].some(isNonEmptyString) || hasGeneratedToolCall(delta));
  });
  if (path === '/v1/completions') return choices(value).some((choice) => isNonEmptyString(choice.text));
  if (path === '/v1/responses') {
    const generatedTypes = new Set(['response.output_text.delta', 'response.reasoning.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta']);
    return typeof value.type === 'string' && generatedTypes.has(value.type) && isNonEmptyString(value.delta);
  }
  return false;
}
function hasGeneratedToolCall(delta: Record<string, unknown>): boolean {
  const legacy = isRecord(delta.function_call) ? delta.function_call : undefined;
  if (legacy !== undefined && [legacy.name, legacy.arguments].some(isNonEmptyString)) return true;
  return Array.isArray(delta.tool_calls) && delta.tool_calls.filter(isRecord).some((toolCall) => {
    const function_ = isRecord(toolCall.function) ? toolCall.function : undefined;
    return function_ !== undefined && [function_.name, function_.arguments].some(isNonEmptyString);
  });
}
function choices(value: Record<string, unknown>): Record<string, unknown>[] { return Array.isArray(value.choices) ? value.choices.filter(isRecord) : []; }
function isNonEmptyString(value: unknown): boolean { return typeof value === 'string' && value.length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
