import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { dshRuntimeAvailable, installedDshRuntime, type InstalledDshRuntime } from './dsh-runtime.js';

interface EntryOptions {
  readonly id?: string;
  readonly name?: string;
  readonly disabled?: boolean;
  readonly config?: Record<string, unknown>;
}

const bundlePatchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));
let dsh: InstalledDshRuntime;

describe.skipIf(!dshRuntimeAvailable())('DSH rc.2 profile composition', () => {
  beforeAll(async () => {
    dsh = await installedDshRuntime();
    expect(dsh.version).toBe('0.1.1-rc.2');
  });

  it('leaves exactly one enabled model selector in Web while retaining online-model rows', () => {
    const base = patches('@deepseek-ai/dsh-base/cordis.patch.yml');
    const web = patches('@deepseek-ai/dsh-web-app/cordis.patch.yml');
    const before = dsh.appBoot.composeEntries([base, web]) as EntryOptions[];
    const composed = dsh.appBoot.composeEntries([base, web, patches(bundlePatchPath)]) as EntryOptions[];

    expect(row(composed, 'ui-model-selection')).toMatchObject({
      name: '@deepseek-ai/dsh-client-ui-model-selection',
      disabled: true,
    });
    expect(row(composed, 'gpu-workload-model-selection')).toMatchObject({
      name: '@local/dsh-gpu-model-selection',
      disabled: false,
    });
    expect(enabledSelectorRows(composed)).toEqual(['gpu-workload-model-selection']);
    expect(row(composed, 'agent-default-model')).toEqual(row(before, 'agent-default-model'));
    expect(row(composed, 'llm-pi-ai')).toEqual(row(before, 'llm-pi-ai'));
    expect(row(composed, 'ui-conversation')).toEqual(row(before, 'ui-conversation'));
  });

  it('configures one manager row from explicit role and endpoint environment values without embedding a credential', () => {
    const composed = composeWeb();
    const manager = row(composed, 'gpu-workload-manager');

    expect(manager).toEqual({
      id: 'gpu-workload-manager',
      name: '@local/dsh-gpu-workload-manager',
      config: {
        role: { __jsExpr: 'process.env.GPU_WORKLOAD_ROLE' },
        managerUrl: {
          __jsExpr: "process.env.GPU_WORKLOAD_MANAGER_URL ?? (process.env.GPU_WORKLOAD_ROLE === 'server' ? 'http://127.0.0.1:8080' : '')",
        },
        managementCredentialRef: 'GPU_MANAGER_KEY',
      },
    });
    expect(JSON.stringify(manager)).not.toMatch(/Bearer|authorization|[A-Fa-f0-9]{64}/);
    expect(JSON.stringify(manager)).not.toContain('DSH_GPU_WORKLOAD');
  });

  it('makes a user re-enable override observable as a two-selector conflict', () => {
    const base = patches('@deepseek-ai/dsh-base/cordis.patch.yml');
    const web = patches('@deepseek-ai/dsh-web-app/cordis.patch.yml');
    const user = [{ id: 'ui-model-selection', disabled: false }];
    const composed = dsh.appBoot.composeEntries([base, web, patches(bundlePatchPath), user]) as EntryOptions[];

    expect(enabledSelectorRows(composed)).toEqual(['ui-model-selection', 'gpu-workload-model-selection']);
  });

  it('keeps the manager in headless and reports only the expected absent stock selector target', () => {
    const warnings: string[] = [];
    const composed = dsh.appBoot.composeEntries([
      patches('@deepseek-ai/dsh-base/cordis.patch.yml'),
      patches('@deepseek-ai/dsh-headless/cordis.patch.yml'),
      patches(bundlePatchPath),
    ], (message) => warnings.push(message)) as EntryOptions[];

    expect(row(composed, 'gpu-workload-manager').name).toBe('@local/dsh-gpu-workload-manager');
    expect(row(composed, 'headless-runner').name).toBe('@deepseek-ai/dsh-headless');
    expect(warnings).toEqual(['patch: entry "ui-model-selection" not found']);
  });
});

function composeWeb(): EntryOptions[] {
  return dsh.appBoot.composeEntries([
    patches('@deepseek-ai/dsh-base/cordis.patch.yml'),
    patches('@deepseek-ai/dsh-web-app/cordis.patch.yml'),
    patches(bundlePatchPath),
  ]) as EntryOptions[];
}

function patches(specifier: string) {
  const path = specifier.startsWith('/') ? specifier : dsh.resolve(specifier);
  return dsh.appBoot.loadOverlayPatches('gpu-workload-bundle-test', path);
}

function row(entries: readonly EntryOptions[], id: string): EntryOptions {
  const matches = entries.filter((entry) => entry.id === id);
  expect(matches, `expected exactly one row ${id}`).toHaveLength(1);
  return matches[0]!;
}

function enabledSelectorRows(entries: readonly EntryOptions[]): string[] {
  return entries
    .filter((entry) => (entry.id === 'ui-model-selection' || entry.id === 'gpu-workload-model-selection') && entry.disabled !== true)
    .map((entry) => entry.id!);
}
