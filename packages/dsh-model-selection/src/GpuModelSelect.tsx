import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ManagerAvailability } from './policy.js';
import { isManagedLocalModel, modelPolicy } from './policy.js';
import './styles.css';

type Pane = 'root' | 'model' | 'effort';

export interface ReasoningEffort {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface ModelReasoning {
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort?: string;
}

export interface ModelOption {
  readonly providerId: string;
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly reasoning?: ModelReasoning;
}

export interface SelectionOutcome {
  readonly accepted: boolean;
  readonly error?: string;
}

type SelectionResult = void | boolean | SelectionOutcome;

export interface DirectoryFailure {
  readonly id: string;
  readonly name: string;
  readonly message: string;
}

export interface GpuModelSelectProps {
  readonly options: readonly ModelOption[];
  readonly current: (Pick<ModelOption, 'providerId' | 'id'> & { readonly reasoningEffort?: string }) | null;
  readonly manager: ManagerAvailability | null;
  readonly onSelect: (option: ModelOption) => SelectionResult | Promise<SelectionResult>;
  readonly onSelectEffort?: (effort: string | undefined) => SelectionResult | Promise<SelectionResult>;
  readonly onOpenManager: () => void;
  readonly onOpenMenu?: () => void;
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly onReload?: () => void;
  readonly directoryStatus?: 'idle' | 'loading' | 'ready' | 'selecting' | 'error';
  readonly directoryError?: string | null;
  readonly failures?: readonly DirectoryFailure[];
  readonly locked?: boolean;
}

interface EffortChoice {
  readonly key: string;
  readonly effort: string | undefined;
  readonly label: string;
  readonly description?: string;
}

export function GpuModelSelect({
  options,
  current,
  manager,
  onSelect,
  onSelectEffort,
  onOpenManager,
  onOpenMenu,
  onMenuOpenChange,
  onReload,
  directoryStatus = 'ready',
  directoryError = null,
  failures = [],
  locked = false,
}: GpuModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>('root');
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const enabledRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const currentOption = options.find((option) => option.providerId === current?.providerId && option.id === current.id);
  const entries = useMemo(
    () => options.map((option) => ({ option, policy: modelPolicy(option, manager) })),
    [options, manager],
  );
  const reasoning = currentOption?.reasoning;
  const effectiveEffort = current?.reasoningEffort ?? reasoning?.defaultEffort;
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? '提供方默认'
      : reasoning.efforts.find((effort) => effort.id === effectiveEffort)?.name ?? effectiveEffort;
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...(reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: '提供方默认' }]
        : []),
      ...reasoning.efforts.map((effort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
        ...(effort.description === undefined ? {} : { description: effort.description }),
      })),
    ], [reasoning]);
  const currentPolicy = currentOption === undefined ? { disabled: false as const } : modelPolicy(currentOption, manager);
  const busy = directoryStatus === 'selecting';

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);

  const show = (): void => {
    setPane('root');
    setSelectionError(null);
    setOpen(true);
    onMenuOpenChange?.(true);
    onOpenMenu?.();
  };

  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    onMenuOpenChange?.(false);
    setPane('root');
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };

  enabledRefs.current = [];
  let enabledIndex = 0;
  const enabledRef = (enabled: boolean) => {
    if (!enabled) return undefined;
    const index = enabledIndex++;
    return (node: HTMLButtonElement | null): void => { enabledRefs.current[index] = node; };
  };

  const moveFocus = (event: KeyboardEvent<HTMLElement>, delta: number) => {
    event.preventDefault();
    const refs = enabledRefs.current.filter((value): value is HTMLButtonElement => value !== null);
    if (refs.length === 0) return;
    const currentIndex = refs.indexOf(document.activeElement as HTMLButtonElement);
    const next = currentIndex < 0 ? (delta > 0 ? 0 : refs.length - 1) : (currentIndex + delta + refs.length) % refs.length;
    refs[next]?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (pane === 'root') close(true);
      else setPane('root');
      return;
    }
    if (event.key === 'ArrowDown') moveFocus(event, 1);
    if (event.key === 'ArrowUp') moveFocus(event, -1);
  };

  const settle = (result: SelectionResult): void => {
    const outcome = normalizeOutcome(result);
    if (outcome.accepted) {
      setSelectionError(null);
      close(true);
      return;
    }
    setSelectionError(outcome.error ?? '模型选择失败，请重试');
  };

  const chooseModel = async (option: ModelOption): Promise<void> => {
    if (busy) return;
    if (option.providerId === current?.providerId && option.id === current.id && !isManagedLocalModel(option)) {
      close(true);
      return;
    }
    setSelectionError(null);
    try {
      settle(await onSelect(option));
    } catch (error) {
      setSelectionError(safeSelectionError(error));
    }
  };

  const chooseEffort = async (effort: string | undefined): Promise<void> => {
    if (busy || currentPolicy.disabled || onSelectEffort === undefined) return;
    if (effort === effectiveEffort) {
      close(true);
      return;
    }
    setSelectionError(null);
    try {
      settle(await onSelectEffort(effort));
    } catch (error) {
      setSelectionError(safeSelectionError(error));
    }
  };

  const modelLabel = currentOption?.label ?? '选择模型';
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`;
  const triggerAria = currentOption === undefined
    ? '选择模型'
    : effortLabel === undefined
      ? `当前模型 ${modelLabel}`
      : `当前模型 ${modelLabel}，推理等级 ${effortLabel}`;

  return <div className="gpu-model-control" ref={rootRef}>
    <button
      ref={triggerRef}
      type="button"
      className="gpu-model-trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={triggerAria}
      title={triggerLabel}
      disabled={locked}
      onClick={() => { if (open) close(false); else show(); }}
    >{triggerLabel}</button>
    <Button type="button" size="sm" variant="outline" aria-label="GPU Workload Manager" onClick={onOpenManager}>GPU</Button>
    {open ? <div
      id={menuId}
      role="menu"
      aria-label="模型选择"
      aria-busy={directoryStatus === 'loading' || busy}
      className="gpu-model-menu"
      onKeyDown={onMenuKeyDown}
    >
      {pane === 'root' ? <>
        <button ref={enabledRef(true)} type="button" role="menuitem" className="gpu-model-cell" onClick={() => setPane('model')}>
          <span>模型</span><span className="gpu-model-cell-value">{modelLabel}</span><span aria-hidden="true">›</span>
        </button>
        {reasoning !== undefined ? <button
          ref={enabledRef(!currentPolicy.disabled)}
          type="button"
          role="menuitem"
          aria-disabled={currentPolicy.disabled || undefined}
          className="gpu-model-cell"
          data-disabled={currentPolicy.disabled ? '' : undefined}
          onClick={() => { if (!currentPolicy.disabled) setPane('effort'); }}
        >
          <span>推理等级</span><span className="gpu-model-cell-value">{effortLabel}</span><span aria-hidden="true">›</span>
        </button> : null}
      </> : null}

      {pane === 'model' ? <>
        {directoryStatus === 'loading' ? <div className="gpu-model-status">正在刷新模型列表…</div> : null}
        {directoryError !== null ? <DirectoryIssue className="gpu-model-error" text={directoryError} onReload={onReload} /> : null}
        {failures.map((failure) => <DirectoryIssue
          key={failure.id}
          className="gpu-model-warning"
          text={`${failure.name}：${failure.message}`}
          onReload={onReload}
        />)}
        <div className="gpu-model-options">
          {entries.map(({ option, policy }) => {
            const active = option.providerId === current?.providerId && option.id === current.id;
            const disabled = policy.disabled || busy;
            const reason = policy.disabled ? policy.reason : busy ? '正在切换模型' : undefined;
            const reasonId = `${menuId}-${safeId(option.providerId)}-${safeId(option.id)}-reason`;
            const row = <button
              key={`${option.providerId}/${option.id}`}
              ref={enabledRef(!disabled)}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              aria-disabled={disabled || undefined}
              aria-describedby={reason === undefined ? undefined : reasonId}
              data-disabled={disabled ? '' : undefined}
              className="gpu-model-row"
              onClick={() => { if (!disabled) void chooseModel(option); }}
              onKeyDown={(event) => {
                if (disabled && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
              }}
            >
              <span className="gpu-model-row-label">{option.label}</span>
              {option.detail ? <span className="gpu-model-row-detail">{option.detail}</span> : null}
              {active ? <span className="gpu-model-check" aria-hidden="true" /> : null}
              {reason === undefined ? null : <span id={reasonId} className="gpu-visually-hidden">{reason}</span>}
            </button>;
            return policy.disabled
              ? <Tooltip key={`${option.providerId}/${option.id}`} label={policy.reason} side="right" delayMs={0}>{row}</Tooltip>
              : row;
          })}
        </div>
        {directoryStatus === 'ready' && entries.length === 0 ? <div className="gpu-model-empty">没有可用模型</div> : null}
      </> : null}

      {pane === 'effort' ? <>
        {directoryError !== null ? <DirectoryIssue className="gpu-model-error" text={directoryError} onReload={onReload} /> : null}
        {effortChoices.length === 0 ? <div className="gpu-model-empty">此模型没有可选推理等级</div> : effortChoices.map((choice) => {
          const disabled = busy || currentPolicy.disabled || onSelectEffort === undefined;
          const reason = currentPolicy.disabled ? currentPolicy.reason : undefined;
          const reasonId = `${menuId}-${safeId(choice.key)}-reason`;
          const row = <button
            key={choice.key}
            ref={enabledRef(!disabled)}
            type="button"
            role="menuitemradio"
            aria-checked={choice.effort === effectiveEffort}
            aria-disabled={disabled || undefined}
            aria-describedby={reason === undefined ? undefined : reasonId}
            data-disabled={disabled ? '' : undefined}
            className="gpu-model-row"
            onClick={() => { if (!disabled) void chooseEffort(choice.effort); }}
          >
            <span className="gpu-model-row-label">{choice.label}</span>
            {choice.description === undefined ? null : <span className="gpu-model-row-detail">{choice.description}</span>}
            {choice.effort === effectiveEffort ? <span className="gpu-model-check" aria-hidden="true" /> : null}
            {reason === undefined ? null : <span id={reasonId} className="gpu-visually-hidden">{reason}</span>}
          </button>;
          return currentPolicy.disabled
            ? <Tooltip key={choice.key} label={currentPolicy.reason} side="right" delayMs={0}>{row}</Tooltip>
            : row;
        })}
      </> : null}

      {selectionError === null ? null : <div role="alert" className="gpu-model-selection-error">{selectionError}</div>}
    </div> : null}
  </div>;
}

function DirectoryIssue({ className, text, onReload }: { readonly className: string; readonly text: string; readonly onReload?: () => void }) {
  return <div className={className}>
    <span>{text}</span>
    {onReload === undefined ? null : <button type="button" className="gpu-model-retry" onClick={onReload}>重试</button>}
  </div>;
}

function normalizeOutcome(result: SelectionResult): SelectionOutcome {
  if (typeof result === 'boolean') return { accepted: result };
  if (result !== undefined) return result;
  return { accepted: true };
}

function safeSelectionError(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : '模型选择失败，请重试';
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}
