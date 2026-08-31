import { useEffect, useRef } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { GpuManagerStatus, GpuModel, LocalModelId } from '@local/dsh-gpu-workload-manager/types';
import './styles.css';

export interface ManualAction {
  readonly action: 'load' | 'switch' | 'unload';
  readonly model?: LocalModelId;
  readonly onBusy: 'reject' | 'queue' | 'force';
}

export interface BusyChoice {
  readonly action: 'load' | 'switch' | 'unload';
  readonly model?: LocalModelId;
  readonly activeRequestCount: number;
  readonly activeModel?: LocalModelId;
  readonly targetModel?: LocalModelId;
}

export interface GpuManagerDialogProps {
  readonly open: boolean;
  readonly status: GpuManagerStatus | null;
  readonly models: readonly GpuModel[];
  readonly busy: BusyChoice | null;
  readonly pending: boolean;
  readonly error?: string | null;
  readonly onAction: (action: ManualAction) => void;
  readonly onCancelOperation: (operationId: string) => void;
  readonly onQueue: () => void;
  readonly onForce: () => void;
  readonly onClose: () => void;
}

const LABELS: Readonly<Record<LocalModelId, string>> = Object.freeze({
  'qwen3.8-27b': 'Qwen3.8 27B Q5',
  'qwen3.8-27b-uncensored': 'Qwen3.8 27B Uncensored Q5',
  'qwen3.8-27b-q4': 'Qwen3.8 27B Q4',
  'qwen3.8-27b-uncensored-q4': 'Qwen3.8 27B Uncensored Q4',
});

export function GpuManagerDialog(props: GpuManagerDialogProps) {
  const queueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.open && props.busy !== null && !props.pending) queueRef.current?.focus();
  }, [props.open, props.busy, props.pending]);

  if (props.busy !== null) {
    const target = props.busy.targetModel ?? props.busy.model ?? '无';
    return <Modal
      open={props.open}
      onClose={props.onClose}
      title="GPU 正在处理本地请求"
      closeLabel="关闭对话框"
      description={`当前有 ${props.busy.activeRequestCount} 个本地请求正在运行。`}
      footer={<>
        <Button type="button" variant="ghost" disabled={props.pending} onClick={props.onClose}>取消</Button>
        <button ref={queueRef} type="button" className="gpu-workload-queue" disabled={props.pending} onClick={props.onQueue}>排队</button>
        <Button type="button" variant="outline" className="gpu-workload-danger" disabled={props.pending} onClick={props.onForce}>强行停止并切换</Button>
      </>}
    >
      <dl className="gpu-workload-details">
        <div><dt>当前模型</dt><dd>{props.busy.activeModel ?? '无'}</dd></div>
        <div><dt>目标模型</dt><dd>{target}</dd></div>
        <div><dt>本地请求</dt><dd>{props.busy.activeRequestCount}</dd></div>
      </dl>
    </Modal>;
  }

  const active = props.status?.activeModel;
  const queued = props.status?.activeOperation?.status === 'QUEUED' ? props.status.activeOperation : undefined;
  return <Modal
    open={props.open}
    onClose={props.pending ? () => undefined : props.onClose}
    title="GPU Workload Manager"
    closeLabel="关闭对话框"
    description="手动装载、切换或卸载 Ubuntu GPU 上的本地模型。"
    footer={<Button type="button" variant="ghost" disabled={props.pending} onClick={props.onClose}>关闭</Button>}
  >
    <div className="gpu-workload-status" aria-live="polite">
      <span>状态：{props.status?.phase ?? '不可用'}</span>
      <span>当前模型：{active ?? '无'}</span>
      <span>本地请求：{props.status?.activeRequestCount ?? 0}</span>
    </div>
    {props.error ? <p role="alert" className="gpu-workload-error">{props.error}</p> : null}
    <div className="gpu-workload-models">
      {props.models.map((model) => {
        const isActive = active === model.id;
        const action = active === undefined ? 'load' : 'switch';
        const verb = action === 'load' ? '装载' : '切换到';
        return <div key={model.id} className="gpu-workload-model">
          <span><strong>{LABELS[model.id]}</strong><small>{model.status.value}</small></span>
          {isActive
            ? <span aria-label={`当前 ${LABELS[model.id]}`} className="gpu-workload-current">当前</span>
            : <Button type="button" size="sm" variant="outline" disabled={props.pending} onClick={() => props.onAction({ action, model: model.id, onBusy: 'reject' })}>{verb} {LABELS[model.id]}</Button>}
        </div>;
      })}
    </div>
    <div className="gpu-workload-secondary-actions">
      <Button type="button" size="sm" variant="outline" disabled={props.pending || active === undefined} onClick={() => props.onAction({ action: 'unload', onBusy: 'reject' })}>卸载模型</Button>
      {queued ? <Button type="button" size="sm" variant="ghost" disabled={props.pending} onClick={() => props.onCancelOperation(queued.id)}>取消排队操作</Button> : null}
    </div>
  </Modal>;
}
