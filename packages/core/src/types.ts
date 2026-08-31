export type ManagerPhase =
  | 'UNLOADED'
  | 'STARTING'
  | 'WARMING'
  | 'READY'
  | 'DRAINING'
  | 'FORCING'
  | 'STOPPING'
  | 'FAILED'
  | 'DEGRADED_UNLOADED';

export type BusyPolicy = 'reject' | 'queue' | 'force';
export type OperationAction = 'load' | 'switch' | 'unload';
export type OperationStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface ModelSpec {
  readonly id: string;
  readonly path: string;
  readonly contextSize: number;
  readonly mtp: number;
}

export interface OperationRequest {
  readonly idempotencyKey: string;
  readonly action: OperationAction;
  readonly model?: string;
  readonly onBusy: BusyPolicy;
}

export interface OperationSnapshot {
  readonly id: string;
  readonly request: OperationRequest;
  readonly status: OperationStatus;
}

export interface ManagerSnapshot {
  readonly phase: ManagerPhase;
  readonly activeModel?: string;
  readonly activeOperation?: OperationSnapshot;
}
