import { randomUUID } from 'node:crypto';
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import type { GpuCancelResult, GpuManagerStatus, GpuOperationRequest, GpuSubmitResult, LocalModelId } from './types.js';

export type { LocalModelId } from './types.js';

export const LOCAL_MODEL_IDS = Object.freeze([
  'qwen3.8-27b',
  'qwen3.8-27b-uncensored',
  'qwen3.8-27b-q4',
  'qwen3.8-27b-uncensored-q4',
] as const satisfies readonly LocalModelId[]);
export type ParsedGpuCommand =
  | { readonly kind: 'open' }
  | { readonly kind: 'status' }
  | { readonly kind: 'cancel' }
  | {
    readonly kind: 'submit';
    readonly action: 'load' | 'switch' | 'unload';
    readonly model?: LocalModelId;
    readonly onBusy: 'reject' | 'queue' | 'force';
  };

const LOCAL_MODELS = new Set<string>(LOCAL_MODEL_IDS);

export function parseGpuCommand(rawInput: string): ParsedGpuCommand {
  const trimmed = rawInput.trim();
  if (trimmed === '') return Object.freeze({ kind: 'open' });
  const tokens = trimmed.split(/\s+/u);
  const policies = tokens.filter((token) => token === '--queue' || token === '--force');
  if (policies.length > 1 || tokens.some((token) => token.startsWith('--') && token !== '--queue' && token !== '--force')) return invalid();
  const positional = tokens.filter((token) => token !== '--queue' && token !== '--force');
  const onBusy = policies[0] === '--queue' ? 'queue' : policies[0] === '--force' ? 'force' : 'reject';
  const verb = positional[0];

  if (verb === 'status' && positional.length === 1 && policies.length === 0) return Object.freeze({ kind: 'status' });
  if (verb === 'cancel' && positional.length === 1 && policies.length === 0) return Object.freeze({ kind: 'cancel' });
  if (verb === 'unload' && positional.length === 1) return Object.freeze({ kind: 'submit', action: 'unload', onBusy });
  if ((verb === 'load' || verb === 'switch') && positional.length === 2 && LOCAL_MODELS.has(positional[1]!)) {
    return Object.freeze({ kind: 'submit', action: verb, model: positional[1] as LocalModelId, onBusy });
  }
  return invalid();
}

function invalid(): never { throw new Error('invalid_gpu_command'); }

export interface GpuWorkloadApi {
  status(signal: AbortSignal): Promise<GpuManagerStatus>;
  submit(request: GpuOperationRequest, signal: AbortSignal): Promise<GpuSubmitResult>;
  cancel(operationId: string, signal: AbortSignal): Promise<GpuCancelResult>;
}

export function createGpuCommand(api: GpuWorkloadApi): CommandDefinition {
  return Object.freeze({
    name: 'gpu',
    description: '打开 GPU Workload Manager 或执行手动模型操作',
    handler: async ({ rawInput, signal }: CommandInvocation): Promise<CommandResult> => {
      let command: ParsedGpuCommand;
      try { command = parseGpuCommand(rawInput); }
      catch { return usageError(); }
      if (command.kind === 'open') return { kind: 'success' };
      try {
        if (command.kind === 'status') return { kind: 'success', text: formatStatus(await api.status(signal)) };
        if (command.kind === 'cancel') {
          const operationId = (await api.status(signal)).activeOperation?.id;
          if (operationId === undefined) return { kind: 'error', text: '当前没有可取消的排队操作' };
          return formatCancel(await api.cancel(operationId, signal));
        }
        const request: GpuOperationRequest = command.action === 'unload'
          ? { idempotencyKey: randomUUID(), action: 'unload', onBusy: command.onBusy }
          : { idempotencyKey: randomUUID(), action: command.action, model: command.model!, onBusy: command.onBusy };
        return formatSubmit(command, await api.submit(request, signal));
      } catch {
        return { kind: 'error', text: 'GPU Workload Manager 暂不可用' };
      }
    },
  });
}

function formatStatus(status: GpuManagerStatus): string {
  const lines = [
    `GPU 状态: ${status.phase}`,
    `当前模型: ${status.activeModel ?? '无'}`,
    `本地请求: ${status.activeRequestCount}`,
  ];
  if (status.target !== undefined) lines.push(`目标模型: ${status.target}`);
  if (status.activeOperation !== undefined) lines.push(`操作: ${status.activeOperation.status} (${status.activeOperation.id})`);
  return lines.join('\n');
}

function formatSubmit(command: Extract<ParsedGpuCommand, { kind: 'submit' }>, result: GpuSubmitResult): CommandResult {
  if (result.kind === 'accepted') return { kind: 'success', text: `操作已提交: ${result.operation.id} (${result.operation.status})` };
  if (result.kind === 'conflict') return { kind: 'error', text: result.code === 'operation_in_progress' ? '另一个 GPU 操作正在进行' : '该操作标识与已有请求冲突' };
  const base = command.action === 'unload' ? '/gpu unload' : `/gpu ${command.action} ${command.model}`;
  return {
    kind: 'error',
    text: `当前有 ${result.activeRequestCount} 个本地请求正在运行。可使用 ${base} --queue 排队，或使用 ${base} --force 强行停止并切换。`,
  };
}

function formatCancel(result: GpuCancelResult): CommandResult {
  if (result.kind === 'cancelled') return { kind: 'success', text: `已取消排队操作: ${result.operation.id}` };
  return { kind: 'error', text: result.code === 'operation_not_cancellable' ? '当前操作已经无法取消' : '找不到要取消的操作' };
}

function usageError(): CommandResult {
  return { kind: 'error', text: '用法: /gpu status | /gpu load <model> [--queue|--force] | /gpu switch <model> [--queue|--force] | /gpu unload [--queue|--force] | /gpu cancel' };
}
