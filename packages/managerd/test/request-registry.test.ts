import { expect, it } from 'vitest';
import { RequestRegistry } from '../src/request-registry.js';

it('closes admission and waits for the already-admitted request without letting another request slip in', async () => {
  const registry = new RequestRegistry({ maximumActive: 1 });
  const lease = registry.admit('qwen3.8-27b');
  expect(lease.kind).toBe('admitted');
  if (lease.kind !== 'admitted') throw new Error('expected_lease');

  const drained = registry.closeAdmissionAndWhenIdle();
  expect(registry.admit('qwen3.8-27b')).toMatchObject({ kind: 'rejected', code: 'model_transition' });
  let settled = false;
  void drained.then(() => { settled = true; });
  expect(settled).toBe(false);

  lease.lease.complete();
  await drained;
  expect(registry.count()).toBe(0);
});

it('aborts every local lease exactly once even when callbacks complete re-entrantly', () => {
  const registry = new RequestRegistry({ maximumActive: 2 });
  const first = registry.admit('qwen3.8-27b');
  const second = registry.admit('qwen3.8-27b');
  if (first.kind !== 'admitted' || second.kind !== 'admitted') throw new Error('expected_leases');
  let firstAborts = 0;
  let secondAborts = 0;
  first.lease.bindAbort(() => { firstAborts += 1; first.lease.complete(); });
  second.lease.bindAbort(() => { secondAborts += 1; second.lease.complete(); });

  registry.abortAll();
  registry.abortAll();

  expect([firstAborts, secondAborts]).toEqual([1, 1]);
  expect(registry.count()).toBe(0);
});

it('continues aborting after a throwing callback and still finalizes every lease', () => {
  const registry = new RequestRegistry({ maximumActive: 2 });
  const first = registry.admit('qwen3.8-27b');
  const second = registry.admit('qwen3.8-27b');
  if (first.kind !== 'admitted' || second.kind !== 'admitted') throw new Error('expected_leases');
  let secondAborts = 0;
  first.lease.bindAbort(() => { first.lease.complete(); throw new Error('downstream_destroy_failed'); });
  second.lease.bindAbort(() => { secondAborts += 1; });
  expect(() => registry.abortAll()).not.toThrow();
  registry.abortAll();
  first.lease.complete();
  second.lease.complete();
  expect(secondAborts).toBe(1);
  expect(registry.count()).toBe(0);
});
