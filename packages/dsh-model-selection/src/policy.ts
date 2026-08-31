import type { GpuManagerStatus, ManagerPhase } from '@local/dsh-gpu-workload-manager/types';

export const DISABLED_LOCAL_REASON = '请通过 GPU Workload Manager 切换';
export const LOCAL_PROVIDER_ID = 'llama-local';
export const LOCAL_MODEL_IDS = Object.freeze([
  'qwen3.8-27b',
  'qwen3.8-27b-uncensored',
  'qwen3.8-27b-q4',
  'qwen3.8-27b-uncensored-q4',
] as const);

export interface ModelIdentity {
  readonly providerId: string;
  readonly id: string;
}

export interface ManagerAvailability {
  readonly phase: ManagerPhase;
  readonly activeModel?: string;
}

export type ModelAvailability =
  | { readonly disabled: false }
  | { readonly disabled: true; readonly reason: typeof DISABLED_LOCAL_REASON };

export function isManagedLocalModel(model: ModelIdentity): boolean {
  return model.providerId === LOCAL_PROVIDER_ID;
}

export function modelPolicy(model: ModelIdentity, status: ManagerAvailability | Pick<GpuManagerStatus, 'phase' | 'activeModel'> | null): ModelAvailability {
  if (!isManagedLocalModel(model)) return Object.freeze({ disabled: false });
  if (status?.phase === 'READY' && status.activeModel === model.id) return Object.freeze({ disabled: false });
  return Object.freeze({ disabled: true, reason: DISABLED_LOCAL_REASON });
}
