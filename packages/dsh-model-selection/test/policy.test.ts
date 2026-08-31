import { describe, expect, it } from 'vitest';
import { DISABLED_LOCAL_REASON, modelPolicy, type ManagerAvailability } from '../src/policy.js';

const localBase = { providerId: 'llama-local', id: 'qwen3.8-27b' };
const localQ4 = { providerId: 'llama-local', id: 'qwen3.8-27b-q4' };
const cloud = { providerId: 'deepseek', id: 'deepseek-chat' };

describe('modelPolicy', () => {
  it('enables only the resident local model while READY', () => {
    const ready: ManagerAvailability = { phase: 'READY', activeModel: localBase.id };
    expect(modelPolicy(localBase, ready)).toEqual({ disabled: false });
    expect(modelPolicy(localQ4, ready)).toEqual({ disabled: true, reason: DISABLED_LOCAL_REASON });
  });

  it.each(['UNLOADED', 'STARTING', 'WARMING', 'DRAINING', 'FORCING', 'STOPPING', 'FAILED', 'DEGRADED_UNLOADED'] as const)(
    'disables every local model during %s',
    (phase) => {
      expect(modelPolicy(localBase, { phase })).toEqual({ disabled: true, reason: DISABLED_LOCAL_REASON });
      expect(modelPolicy(localQ4, { phase, activeModel: localBase.id })).toEqual({ disabled: true, reason: DISABLED_LOCAL_REASON });
    },
  );

  it('never changes online model availability', () => {
    expect(modelPolicy(cloud, { phase: 'UNLOADED' })).toEqual({ disabled: false });
    expect(modelPolicy(cloud, { phase: 'DRAINING', activeModel: localBase.id })).toEqual({ disabled: false });
    expect(modelPolicy(cloud, null)).toEqual({ disabled: false });
  });

  it('never governs a non-local provider even when it reuses a local model id', () => {
    expect(modelPolicy({ providerId: 'online-aggregator', id: localQ4.id }, { phase: 'UNLOADED' })).toEqual({ disabled: false });
    expect(modelPolicy({ providerId: 'online-aggregator', id: localQ4.id }, { phase: 'DRAINING', activeModel: localBase.id })).toEqual({ disabled: false });
  });
});
