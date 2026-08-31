/** Browser-safe GPU manager wire contracts. Keep this module free of Host imports. */
export type LocalModelId =
  | 'qwen3.8-27b'
  | 'qwen3.8-27b-uncensored'
  | 'qwen3.8-27b-q4'
  | 'qwen3.8-27b-uncensored-q4';

export type ManagerPhase = 'UNLOADED' | 'STARTING' | 'WARMING' | 'READY' | 'DRAINING' | 'FORCING' | 'STOPPING' | 'FAILED' | 'DEGRADED_UNLOADED';
export type BusyPolicy = 'reject' | 'queue' | 'force';
export type OperationAction = 'load' | 'switch' | 'unload';
export type OperationStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface GpuOperationRequest {
  readonly idempotencyKey: string;
  readonly action: OperationAction;
  readonly model?: LocalModelId;
  readonly onBusy: BusyPolicy;
}

export interface GpuOperation {
  readonly id: string;
  readonly request: GpuOperationRequest;
  readonly status: OperationStatus;
  readonly error?: { readonly code: string };
  readonly result?: { readonly activeModel?: LocalModelId };
}

export interface GpuManagerStatus {
  readonly phase: ManagerPhase;
  readonly activeModel?: LocalModelId;
  readonly activeRequestCount: number;
  readonly target?: LocalModelId;
  readonly activeOperation?: GpuOperation;
}

export interface GpuModel {
  readonly id: LocalModelId;
  readonly object: 'model';
  readonly status: { readonly value: 'loaded' | 'loading' | 'unloaded' };
}

export interface GpuModelList {
  readonly object: 'list';
  readonly data: readonly GpuModel[];
}

export type GpuSubmitResult =
  | { readonly kind: 'accepted'; readonly operation: GpuOperation }
  | { readonly kind: 'busy'; readonly code: 'local_model_busy'; readonly activeRequestCount: number; readonly activeModel?: LocalModelId; readonly targetModel?: LocalModelId }
  | { readonly kind: 'conflict'; readonly code: 'idempotency_conflict' | 'operation_in_progress' };

export type GpuCancelResult =
  | { readonly kind: 'cancelled'; readonly operation: GpuOperation }
  | { readonly kind: 'conflict'; readonly code: 'operation_not_cancellable' | 'operation_not_found' };
