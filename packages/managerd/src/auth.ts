import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type CredentialRealm = 'inference' | 'management';

export function hasBearerCredential(request: IncomingMessage, expected: string): boolean {
  const authorization = rawHeaderValues(request, 'authorization');
  if (authorization.length !== 1 || authorization[0].includes(',')) return false;
  const match = /^Bearer ([0-9a-fA-F]{64})$/i.exec(authorization[0]);
  if (match === null || !/^[0-9a-fA-F]{64}$/.test(expected)) return false;
  const supplied = Buffer.from(match[1], 'hex');
  const configured = Buffer.from(expected, 'hex');
  return supplied.length === 32 && configured.length === 32 && timingSafeEqual(supplied, configured);
}

export function rejectUnauthorized(response: ServerResponse): void {
  response.writeHead(401, { 'www-authenticate': 'Bearer', 'cache-control': 'no-store', 'content-type': 'application/json' });
  response.end('{"error":{"code":"unauthorized"}}');
}

export function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index].toLowerCase() === name) values.push(request.rawHeaders[index + 1]);
  return values;
}
