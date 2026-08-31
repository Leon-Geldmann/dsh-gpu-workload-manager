// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GpuManagerDialog } from '../src/GpuManagerDialog.js';

afterEach(cleanup);

describe('GpuManagerDialog', () => {
  it('gives Queue default focus and Enter, while Force is red and never default-focused', async () => {
    const queue = vi.fn(); const force = vi.fn(); const close = vi.fn();
    render(<GpuManagerDialog open status={{ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 2 }} models={[]} busy={{ action: 'switch', model: 'qwen3.8-27b-q4', activeRequestCount: 2, activeModel: 'qwen3.8-27b', targetModel: 'qwen3.8-27b-q4' }} pending={false} onAction={() => undefined} onCancelOperation={() => undefined} onQueue={queue} onForce={force} onClose={close} />);
    const queueButton = screen.getByRole('button', { name: '排队' });
    const forceButton = screen.getByRole('button', { name: '强行停止并切换' });
    await waitFor(() => expect(queueButton).toHaveFocus());
    expect(forceButton).not.toHaveFocus();
    expect(forceButton).toHaveClass('gpu-workload-danger');
    fireEvent.keyDown(queueButton, { key: 'Enter' });
    fireEvent.click(queueButton);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(force).not.toHaveBeenCalled();
    fireEvent.click(forceButton);
    expect(force).toHaveBeenCalledTimes(1);
  });

  it('focuses Queue when a busy response becomes actionable after its pending request settles', async () => {
    const busy = { action: 'switch' as const, model: 'qwen3.8-27b-q4' as const, activeRequestCount: 2, activeModel: 'qwen3.8-27b' as const, targetModel: 'qwen3.8-27b-q4' as const };
    const { rerender } = render(<GpuManagerDialog open status={{ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 2 }} models={[]} busy={busy} pending onAction={() => undefined} onCancelOperation={() => undefined} onQueue={() => undefined} onForce={() => undefined} onClose={() => undefined} />);
    const queueButton = screen.getByRole('button', { name: '排队' });
    expect(queueButton).toBeDisabled();
    expect(queueButton).not.toHaveFocus();

    rerender(<GpuManagerDialog open status={{ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 2 }} models={[]} busy={busy} pending={false} onAction={() => undefined} onCancelOperation={() => undefined} onQueue={() => undefined} onForce={() => undefined} onClose={() => undefined} />);

    await waitFor(() => expect(queueButton).toHaveFocus());
  });

  it('shows busy details and maps Escape and Cancel to a harmless close', () => {
    const close = vi.fn();
    render(<GpuManagerDialog open status={{ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 3 }} models={[]} busy={{ action: 'unload', activeRequestCount: 3, activeModel: 'qwen3.8-27b' }} pending={false} onAction={() => undefined} onCancelOperation={() => undefined} onQueue={() => undefined} onForce={() => undefined} onClose={close} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('3');
    expect(screen.getByRole('dialog')).toHaveTextContent('qwen3.8-27b');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('offers manual load, switch, unload, and queued-operation cancellation without auto actions', () => {
    const action = vi.fn(); const cancelOperation = vi.fn();
    const { rerender } = render(<GpuManagerDialog open status={{ phase: 'UNLOADED', activeRequestCount: 0 }} models={[{ id: 'qwen3.8-27b', object: 'model', status: { value: 'unloaded' } }]} busy={null} pending={false} onAction={action} onCancelOperation={cancelOperation} onQueue={() => undefined} onForce={() => undefined} onClose={() => undefined} />);
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /装载 Qwen3.8 27B/ }));
    expect(action).toHaveBeenCalledWith({ action: 'load', model: 'qwen3.8-27b', onBusy: 'reject' });

    rerender(<GpuManagerDialog open status={{ phase: 'READY', activeModel: 'qwen3.8-27b', activeRequestCount: 0, activeOperation: { id: '22222222-2222-4222-8222-222222222222', request: { idempotencyKey: '11111111-1111-4111-8111-111111111111', action: 'unload', onBusy: 'queue' }, status: 'QUEUED' } }} models={[]} busy={null} pending={false} onAction={action} onCancelOperation={cancelOperation} onQueue={() => undefined} onForce={() => undefined} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '卸载模型' }));
    fireEvent.click(screen.getByRole('button', { name: '取消排队操作' }));
    expect(action).toHaveBeenCalledWith({ action: 'unload', onBusy: 'reject' });
    expect(cancelOperation).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
  });

  it('disables every action while one Remote operation is in flight', () => {
    render(<GpuManagerDialog open status={{ phase: 'UNLOADED', activeRequestCount: 0 }} models={[{ id: 'qwen3.8-27b', object: 'model', status: { value: 'unloaded' } }]} busy={null} pending onAction={() => undefined} onCancelOperation={() => undefined} onQueue={() => undefined} onForce={() => undefined} onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: /装载 Qwen3.8 27B/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
  });
});
