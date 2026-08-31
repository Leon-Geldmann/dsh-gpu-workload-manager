import type { ServerResponse } from 'node:http';

export function jsonError(response: ServerResponse, status: number, code: string, extra: Record<string, unknown> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code, ...extra } }));
}

export function closeJsonError(response: ServerResponse, status: number, code: string): void {
  response.shouldKeepAlive = false;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
  response.end(JSON.stringify({ error: { code } }));
  response.socket?.end();
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body));
}
