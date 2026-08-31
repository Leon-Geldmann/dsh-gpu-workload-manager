import { Context } from '@deepseek-ai/cordis';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { describe, expect, it, vi } from 'vitest';
import { createGpuCommand, parseGpuCommand } from '../src/commands.js';
import GpuWorkloads from '../src/remote.js';

describe('parseGpuCommand', () => {
  it.each([
    ['', { kind: 'open' }],
    [' status ', { kind: 'status' }],
    ['load qwen3.8-27b', { kind: 'submit', action: 'load', model: 'qwen3.8-27b', onBusy: 'reject' }],
    ['switch qwen3.8-27b-q4 --queue', { kind: 'submit', action: 'switch', model: 'qwen3.8-27b-q4', onBusy: 'queue' }],
    ['--force unload', { kind: 'submit', action: 'unload', onBusy: 'force' }],
    ['cancel', { kind: 'cancel' }],
  ] as const)('parses the human-only grammar for %j', (input, expected) => {
    expect(parseGpuCommand(input)).toEqual(expected);
  });

  it.each([
    'start qwen3.8-27b',
    'load',
    'load unknown-model',
    'load qwen3.8-27b extra',
    'unload qwen3.8-27b',
    'status --queue',
    'cancel --force',
    'switch qwen3.8-27b --queue --force',
    'switch qwen3.8-27b --queue --queue',
    '--surprise unload',
  ])('rejects unsafe or ambiguous input %j', (input) => {
    expect(() => parseGpuCommand(input)).toThrow('invalid_gpu_command');
  });
});

describe('DSH human command', () => {
  it('registers one input-less human command and zero model-callable tools', async () => {
    const ctx = await commandContext();
    const registeredTools: unknown[] = [];
    ctx.provide('tools', {
      register: (definition: unknown) => { registeredTools.push(definition); return () => undefined; },
      list: () => Object.freeze([...registeredTools]),
    } as never);
    const resolve = vi.fn(async () => ({ value: 'a'.repeat(64), source: 'test' }));
    ctx.provide('credentials', { resolve } as never);
    await ctx.plugin(GpuWorkloads, { role: 'server', managementCredentialRef: 'GPU_MANAGER_KEY' });
    const agent = makeAgent(ctx, 'gpu-plugin-registration');

    const definition = ctx.commands.find(agent, 'gpu');
    expect(ctx.commands.list(agent).filter(({ name }) => name === 'gpu')).toHaveLength(1);
    expect(definition).toBeDefined();
    expect(Object.hasOwn(definition!, 'input')).toBe(false);
    expect((ctx as unknown as { tools: { list(agent: Agent): readonly { name?: string }[] } }).tools.list(agent).filter(({ name }) => name?.startsWith('gpu'))).toEqual([]);

    await expect(ctx.commands.execute(agent, '/gpu', [], new AbortController().signal)).resolves.toMatchObject({ result: { kind: 'success' } });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('executes the direct human adapter grammar with structured queue and force guidance', async () => {
    const ctx = await commandContext();
    const activeOperation = {
      id: '22222222-2222-4222-8222-222222222222',
      request: { idempotencyKey: '11111111-1111-4111-8111-111111111111', action: 'switch' as const, model: 'qwen3.8-27b-q4' as const, onBusy: 'queue' as const },
      status: 'QUEUED' as const,
    };
    const api = {
      status: vi.fn(async () => ({ phase: 'DRAINING' as const, activeModel: 'qwen3.8-27b' as const, activeRequestCount: 2, target: 'qwen3.8-27b-q4' as const, activeOperation })),
      submit: vi.fn(async (request: { onBusy: string }) => request.onBusy === 'reject'
        ? { kind: 'busy' as const, code: 'local_model_busy' as const, activeRequestCount: 2, activeModel: 'qwen3.8-27b' as const, targetModel: 'qwen3.8-27b-q4' as const }
        : { kind: 'accepted' as const, operation: activeOperation }),
      cancel: vi.fn(async () => ({ kind: 'cancelled' as const, operation: { ...activeOperation, status: 'CANCELLED' as const } })),
    };
    ctx.commands.register(createGpuCommand(api));
    const agent = makeAgent(ctx, 'gpu-command-adapter');
    const run = (line: string) => ctx.commands.execute(agent, line, [], new AbortController().signal).then((value) => value?.result);

    await expect(run('/gpu status')).resolves.toEqual({ kind: 'success', text: 'GPU 状态: DRAINING\n当前模型: qwen3.8-27b\n本地请求: 2\n目标模型: qwen3.8-27b-q4\n操作: QUEUED (22222222-2222-4222-8222-222222222222)' });
    await expect(run('/gpu switch qwen3.8-27b-q4')).resolves.toEqual({
      kind: 'error',
      text: '当前有 2 个本地请求正在运行。可使用 /gpu switch qwen3.8-27b-q4 --queue 排队，或使用 /gpu switch qwen3.8-27b-q4 --force 强行停止并切换。',
    });
    await expect(run('/gpu switch qwen3.8-27b-q4 --queue')).resolves.toEqual({ kind: 'success', text: '操作已提交: 22222222-2222-4222-8222-222222222222 (QUEUED)' });
    await expect(run('/gpu cancel')).resolves.toEqual({ kind: 'success', text: '已取消排队操作: 22222222-2222-4222-8222-222222222222' });
    await expect(run('/gpu load unknown')).resolves.toEqual({
      kind: 'error',
      text: '用法: /gpu status | /gpu load <model> [--queue|--force] | /gpu switch <model> [--queue|--force] | /gpu unload [--queue|--force] | /gpu cancel',
    });

    const queued = api.submit.mock.calls[1]?.[0] as { idempotencyKey: string; onBusy: string };
    expect(queued.onBusy).toBe('queue');
    expect(queued.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(api.cancel).toHaveBeenCalledWith(activeOperation.id, expect.any(AbortSignal));
  });

  it('contains manager failures behind a stable human-safe error', async () => {
    const ctx = await commandContext();
    ctx.commands.register(createGpuCommand({
      status: async () => { throw new Error('upstream included a sensitive path and token'); },
      submit: async () => { throw new Error('not called'); },
      cancel: async () => { throw new Error('not called'); },
    }));
    const agent = makeAgent(ctx, 'gpu-command-error');
    const result = await ctx.commands.execute(agent, '/gpu status', [], new AbortController().signal);
    expect(result?.result).toEqual({ kind: 'error', text: 'GPU Workload Manager 暂不可用' });
    expect(result?.result.text).not.toContain('sensitive');
  });

  it('withdraws the command with its plugin fiber and remounts without a duplicate', async () => {
    const ctx = await commandContext();
    ctx.provide('credentials', { resolve: async () => ({ value: 'a'.repeat(64), source: 'test' }) } as never);
    const agent = makeAgent(ctx, 'gpu-plugin-lifecycle');
    const first = ctx.plugin(GpuWorkloads, { role: 'server', managementCredentialRef: 'GPU_MANAGER_KEY' });
    await first;
    expect(ctx.commands.list(agent).filter(({ name }) => name === 'gpu')).toHaveLength(1);

    await first.dispose();
    expect(ctx.commands.find(agent, 'gpu')).toBeUndefined();

    const second = ctx.plugin(GpuWorkloads, { role: 'server', managementCredentialRef: 'GPU_MANAGER_KEY' });
    await second;
    expect(ctx.commands.list(agent).filter(({ name }) => name === 'gpu')).toHaveLength(1);
  });
});

async function commandContext(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(CommandRuntime);
  return ctx;
}

function makeAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id));
  return { id: session.id, session } as Agent;
}
