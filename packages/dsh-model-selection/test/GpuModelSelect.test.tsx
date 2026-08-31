// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GpuModelSelect, type ModelOption } from '../src/GpuModelSelect.js';

const options: readonly ModelOption[] = [
  { providerId: 'llama-local', id: 'qwen3.8-27b', label: 'Qwen3.8 27B Q5' },
  { providerId: 'llama-local', id: 'qwen3.8-27b-q4', label: 'Qwen3.8 27B Q4' },
  { providerId: 'deepseek', id: 'deepseek-chat', label: 'DeepSeek Chat', reasoning: {
    efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max', description: '最大预算' }],
    defaultEffort: 'high',
  } },
];

afterEach(cleanup);

describe('GpuModelSelect', () => {
  it('guards disabled local rows for pointer, Enter, and Space while cloud remains interactive', () => {
    const select = vi.fn();
    render(<GpuModelSelect options={options} current={{ providerId: 'llama-local', id: 'qwen3.8-27b' }} manager={{ phase: 'READY', activeModel: 'qwen3.8-27b' }} onSelect={select} onOpenManager={() => undefined} />);
    openModelPane(/Qwen3.8 27B Q5/);

    const blocked = screen.getByRole('menuitemradio', { name: /Qwen3.8 27B Q4/ });
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(blocked);
    fireEvent.keyDown(blocked, { key: 'Enter' });
    fireEvent.keyDown(blocked, { key: ' ' });
    expect(select).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek Chat/ }));
    expect(select).toHaveBeenCalledWith(options[2]);
  });

  it('exposes the exact reason through aria-describedby and a focus tooltip', () => {
    render(<GpuModelSelect options={options} current={null} manager={{ phase: 'UNLOADED' }} onSelect={() => undefined} onOpenManager={() => undefined} />);
    openModelPane(/选择模型/);
    const blocked = screen.getByRole('menuitemradio', { name: /Qwen3.8 27B Q5/ });
    const description = blocked.getAttribute('aria-describedby');
    expect(description).toBeTruthy();
    expect(document.getElementById(description!)).toHaveTextContent('请通过 GPU Workload Manager 切换');
    fireEvent.focus(blocked);
    expect(screen.getByRole('tooltip')).toHaveTextContent('请通过 GPU Workload Manager 切换');
  });

  it('skips disabled local rows during circular arrow navigation', () => {
    render(<GpuModelSelect options={options} current={{ providerId: 'llama-local', id: 'qwen3.8-27b' }} manager={{ phase: 'READY', activeModel: 'qwen3.8-27b' }} onSelect={() => undefined} onOpenManager={() => undefined} />);
    openModelPane(/Qwen3.8 27B Q5/);
    const current = screen.getByRole('menuitemradio', { name: /Qwen3.8 27B Q5/ });
    const cloud = screen.getByRole('menuitemradio', { name: /DeepSeek Chat/ });
    current.focus();
    fireEvent.keyDown(current, { key: 'ArrowDown' });
    expect(cloud).toHaveFocus();
    fireEvent.keyDown(cloud, { key: 'ArrowUp' });
    expect(current).toHaveFocus();
  });

  it('revalidates the current managed-local row instead of closing on cached identity alone', () => {
    const select = vi.fn();
    render(<GpuModelSelect options={options} current={{ providerId: 'llama-local', id: 'qwen3.8-27b' }} manager={{ phase: 'READY', activeModel: 'qwen3.8-27b' }} onSelect={select} onOpenManager={() => undefined} />);
    openModelPane(/Qwen3.8 27B Q5/);

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Qwen3.8 27B Q5/ }));

    expect(select).toHaveBeenCalledWith(options[0]);
  });

  it('opens the manager only from its explicit button and respects a locked composer', () => {
    const openManager = vi.fn();
    const { rerender } = render(<GpuModelSelect options={options} current={null} manager={{ phase: 'UNLOADED' }} onSelect={() => undefined} onOpenManager={openManager} />);
    fireEvent.click(screen.getByRole('button', { name: 'GPU Workload Manager' }));
    expect(openManager).toHaveBeenCalledTimes(1);
    rerender(<GpuModelSelect options={options} current={null} manager={{ phase: 'UNLOADED' }} onSelect={() => undefined} onOpenManager={openManager} locked />);
    expect(screen.getByRole('button', { name: /选择模型/ })).toBeDisabled();
  });

  it('reports model-menu open and close so status polling stays scoped', () => {
    const onMenuOpenChange = vi.fn();
    render(<GpuModelSelect options={options} current={null} manager={{ phase: 'UNLOADED' }} onSelect={() => undefined} onOpenManager={() => undefined} onMenuOpenChange={onMenuOpenChange} />);
    const trigger = screen.getByRole('button', { name: /选择模型/ });

    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(onMenuOpenChange.mock.calls.map(([open]) => open)).toEqual([true, false]);
  });

  it('preserves online-model reasoning effort selection', () => {
    const selectEffort = vi.fn();
    render(<GpuModelSelect
      options={options}
      current={{ providerId: 'deepseek', id: 'deepseek-chat', reasoningEffort: 'high' }}
      manager={{ phase: 'UNLOADED' }}
      onSelect={() => undefined}
      onSelectEffort={selectEffort}
      onOpenManager={() => undefined}
    />);
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek Chat.*High/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级.*High/ }));
    const choices = screen.getAllByRole('menuitemradio');
    expect(choices.map((choice) => choice.textContent)).toEqual(['Off', 'High', 'Max最大预算']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }));
    expect(selectEffort).toHaveBeenCalledWith('max');
  });

  it('keeps directory loading, failure, retry, empty, and selection-error surfaces', async () => {
    const reload = vi.fn();
    const { rerender } = render(<GpuModelSelect
      options={[]}
      current={null}
      manager={{ phase: 'UNLOADED' }}
      directoryStatus="loading"
      directoryError="目录离线"
      failures={[{ id: 'online', name: 'Online', message: 'timeout' }]}
      onReload={reload}
      onSelect={() => undefined}
      onOpenManager={() => undefined}
    />);
    openModelPane(/选择模型/);
    expect(screen.getByText('正在刷新模型列表…')).toBeInTheDocument();
    expect(screen.getByText(/目录离线/)).toBeInTheDocument();
    expect(screen.getByText(/Online.*timeout/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0]!);
    expect(reload).toHaveBeenCalledTimes(1);

    rerender(<GpuModelSelect options={[options[2]!]} current={null} manager={{ phase: 'UNLOADED' }} directoryStatus="ready" onSelect={async () => ({ accepted: false, error: '在线选择失败' })} onOpenManager={() => undefined} />);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek Chat/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('在线选择失败');
  });
});

function openModelPane(triggerName: RegExp): void {
  fireEvent.click(screen.getByRole('button', { name: triggerName }));
  fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }));
}
