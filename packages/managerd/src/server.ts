import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ManagerEngine } from './manager-engine.js';
import { parseManagerServerConfig, type ManagerServerConfig, type ValidatedManagerServerConfig } from './config.js';
import { hasBearerCredential, rejectUnauthorized, rawHeaderValues, type CredentialRealm } from './auth.js';
import { json, jsonError } from './http-errors.js';
import { handleControl, modelsBody } from './control-api.js';
import { proxyInference } from './inference-proxy.js';
import type { ChildRequestFactory } from './inference-proxy.js';
import { Metrics } from './metrics.js';

type Route = { readonly realm?: CredentialRealm; readonly kind: 'health' | 'metrics' | 'models' | 'inference' | 'control'; readonly allowed: readonly string[] };
const INFERENCE_PATHS = new Set(['/v1/chat/completions', '/v1/completions', '/v1/responses']);

export interface ManagerServer extends Server { shutdown(): Promise<void>; }
export interface ManagerServerDependencies { readonly childRequest?: ChildRequestFactory; readonly metrics?: Metrics; }

export function createManagerServer(options: ManagerServerConfig, engine: ManagerEngine, dependencies: ManagerServerDependencies = {}): ManagerServer {
  const config = parseManagerServerConfig(options); const metrics = dependencies.metrics ?? new Metrics(config.catalogIds); const sockets = new Set<import('node:net').Socket>(); let shutdown: Promise<void> | undefined;
  (engine as unknown as { configureDrainTimeout?: (timeoutMs: number) => void }).configureDrainTimeout?.(config.limits.drainTimeoutMs);
  const server = createServer({ maxHeaderSize: config.limits.maxHeaderBytes, headersTimeout: config.limits.headersTimeoutMs, requestTimeout: config.limits.requestTimeoutMs, connectionsCheckingInterval: Math.min(1_000, config.limits.headersTimeoutMs, config.limits.requestTimeoutMs), keepAliveTimeout: config.limits.keepAliveTimeoutMs }, (request, response) => {
    void dispatch(request, response, config, engine, metrics, dependencies).catch(() => { if (!response.headersSent && !response.destroyed) jsonError(response, 500, 'internal_error'); else response.destroy(); });
  });
  server.maxHeadersCount = 0;
  const protocolReject = (socket: import('node:stream').Duplex, status: number) => { socket.end(`HTTP/1.1 ${status} ${status === 431 ? 'Request Header Fields Too Large' : 'Bad Request'}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`); };
  server.on('checkContinue', (request, response) => closeResponse(request, response, 417, 'expectation_failed'));
  server.on('checkExpectation', (request, response) => closeResponse(request, response, 417, 'expectation_failed'));
  server.on('upgrade', (_request, socket) => protocolReject(socket, 400));
  server.on('connect', (_request, socket) => protocolReject(socket, 400));
  server.on('clientError', (error, socket) => protocolReject(socket, (error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW' ? 431 : 400));
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const managed = server as ManagerServer;
  managed.shutdown = () => shutdown ??= (async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    try { await engine.shutdown(); }
    finally { server.closeIdleConnections(); server.closeAllConnections(); for (const socket of sockets) socket.destroy(); await closed; }
  })();
  return managed;
}

async function dispatch(request: IncomingMessage, response: ServerResponse, config: ValidatedManagerServerConfig, engine: ManagerEngine, metrics: Metrics, dependencies: ManagerServerDependencies): Promise<void> {
  if (!isTrustedManagerPeer(request.socket.remoteAddress, config.trustedLanCidr)) return closeResponse(request, response, 403, 'untrusted_network');
  const target = request.url ?? '';
  if (invalidTarget(target)) return closeResponse(request, response, 400, 'invalid_request_target');
  const route = classify(target);
  if (route === undefined) return closeResponse(request, response, 404, 'not_found');
  if (!route.allowed.includes(request.method ?? '')) { response.setHeader('allow', route.allowed.join(', ')); return closeResponse(request, response, 405, 'method_not_allowed'); }
  const invalid = invalidRequest(request, config);
  if (invalid !== undefined) return closeResponse(request, response, invalid.status, invalid.code);
  if (route.realm !== undefined && !hasBearerCredential(request, route.realm === 'inference' ? config.inferenceKey : config.managementKey)) return closeResponse(request, response, 401, 'unauthorized', true);
  if (route.kind === 'health') return closeResponse(request, response, 200, undefined, false, '{"status":"ok"}');
  if (route.kind === 'metrics') return closeResponse(request, response, 200, undefined, false, metrics.render(engine.snapshot()), 'text/plain; version=0.0.4');
  if (route.kind === 'models') return closeResponse(request, response, 200, undefined, false, JSON.stringify(modelsBody(engine.snapshot(), config.catalogIds)));
  if (route.kind === 'control') return handleControl(request, response, engine, config.catalogIds, config.limits.controlBodyBytes);
  return proxyInference(request, response, engine, config, metrics, dependencies.childRequest);
}

export function isTrustedManagerPeer(remoteAddress: string | undefined, trustedLanCidr: string): boolean {
  if (remoteAddress === undefined || trustedLanCidr !== '192.168.3.0/24') return false;
  const address = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress;
  if (address === '127.0.0.1' || address === '::1') return true;
  const octets = address.split('.');
  return octets.length === 4
    && octets.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
    && Number(octets[0]) === 192
    && Number(octets[1]) === 168
    && Number(octets[2]) === 3
    && Number(octets[3]) >= 1
    && Number(octets[3]) <= 254;
}

function classify(target: string): Route | undefined {
  if (target === '/health') return { kind: 'health', allowed: ['GET'] };
  if (target === '/metrics') return { kind: 'metrics', realm: 'management', allowed: ['GET'] };
  if (target === '/v1/models') return { kind: 'models', realm: 'inference', allowed: ['GET'] };
  if (INFERENCE_PATHS.has(target)) return { kind: 'inference', realm: 'inference', allowed: ['POST'] };
  if (target === '/gpu/v1/status' || target === '/gpu/v1/models') return { kind: 'control', realm: 'management', allowed: ['GET'] };
  if (target === '/gpu/v1/operations') return { kind: 'control', realm: 'management', allowed: ['POST'] };
  if (/^\/gpu\/v1\/operations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target)) return { kind: 'control', realm: 'management', allowed: ['GET', 'DELETE'] };
  return undefined;
}

function invalidRequest(request: IncomingMessage, config: ValidatedManagerServerConfig): { readonly status: 400 | 413; readonly code: string } | undefined {
  const raw = request.url ?? '';
  if (invalidTarget(raw)) return { status: 400, code: 'invalid_request_target' };
  let decoded: string; try { decoded = decodeURIComponent(raw); } catch { return { status: 400, code: 'invalid_request_target' }; }
  if (decoded.includes('\\') || decoded.split('/').some((segment) => segment === '.' || segment === '..') || raw.includes('//') || (raw.length > 1 && raw.endsWith('/'))) return { status: 400, code: 'invalid_request_target' };
  if (request.rawHeaders.length / 2 > config.limits.maxHeaderCount) return { status: 413, code: 'headers_too_large' };
  const lengths = rawHeaderValues(request, 'content-length'); const transfer = rawHeaderValues(request, 'transfer-encoding');
  const connection = rawHeaderValues(request, 'connection').flatMap((value) => value.split(',').map((token) => token.trim().toLowerCase()));
  if (lengths.length > 1 || (lengths.length > 0 && transfer.length > 0) || transfer.length > 0 || rawHeaderValues(request, 'expect').length > 0 || rawHeaderValues(request, 'trailer').length > 0 || rawHeaderValues(request, 'upgrade').length > 0 || connection.some((name) => ['x-request-id', 'content-type', 'accept', 'accept-encoding'].includes(name)) || request.method === 'CONNECT') return { status: 400, code: 'invalid_request_headers' };
  if (request.method === 'POST' && !isJsonContentType(request.headers['content-type'])) return { status: 400, code: 'invalid_content_type' };
  return undefined;
}
function invalidTarget(raw: string): boolean { if (/^https?:\/\//i.test(raw) || raw.includes('?') || raw.includes('#') || /%(?:2f|5c)/i.test(raw) || /%(?![0-9a-f]{2})/i.test(raw)) return true; try { const decoded = decodeURIComponent(raw); return decoded.includes('\\') || decoded.split('/').some((segment) => segment === '.' || segment === '..') || raw.includes('//') || (raw.length > 1 && raw.endsWith('/')); } catch { return true; } }
function isJsonContentType(value: string | undefined): boolean { return value !== undefined && /^application\/json(?:\s*;\s*charset=(?:utf-8|utf8))?$/i.test(value); }
function closeResponse(request: IncomingMessage, response: ServerResponse, status: number, code?: string, bearer = false, text?: string, contentType = 'application/json'): void { request.pause(); response.shouldKeepAlive = false; response.setHeader('connection', 'close'); response.setHeader('cache-control', 'no-store'); if (bearer) response.setHeader('www-authenticate', 'Bearer'); response.statusCode = status; response.setHeader('content-type', contentType); response.end(text ?? (code === undefined ? '' : JSON.stringify({ error: { code } }))); response.socket?.end(); }
