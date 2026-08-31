import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { OperationStore } from '../src/operation-store.js';

it('retains active records while evicting only the oldest terminal record at capacity', () => {
  let now = 0;
  const store = new OperationStore({ maximumTerminalRecords: 1, now: () => now });
  const first = store.create(request());
  store.finish(first, 'COMPLETED');
  now = 1;
  const active = store.create(request());
  now = 2;
  const later = store.create(request());
  store.finish(later, 'COMPLETED');

  expect(store.get(first.id)).toBeUndefined();
  expect(store.get(active.id)).toMatchObject({ status: 'RUNNING' });
  expect(store.get(later.id)).toMatchObject({ status: 'COMPLETED' });
});

it('expires terminal records after the injected 24-hour retention window without evicting active records', () => {
  let now = 0;
  const store = new OperationStore({ retentionMs: 24 * 60 * 60 * 1000, now: () => now });
  const terminal = store.create(request());
  store.finish(terminal, 'COMPLETED');
  const active = store.create(request());
  now = 24 * 60 * 60 * 1000 + 1;
  store.prune();

  expect(store.get(terminal.id)).toBeUndefined();
  expect(store.get(active.id)).toMatchObject({ status: 'RUNNING' });
});

function request() {
  return { idempotencyKey: randomUUID(), action: 'unload' as const, onBusy: 'reject' as const };
}
