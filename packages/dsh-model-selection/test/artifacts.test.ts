import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';

const run = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = join(packageRoot, '../..');

beforeAll(async () => {
  await run(process.execPath, [join(workspaceRoot, 'node_modules/typescript/bin/tsc'), '-b', join(workspaceRoot, 'tsconfig.host.json')], { cwd: workspaceRoot });
  await run(process.execPath, [join(workspaceRoot, 'node_modules/tsdown/dist/run.mjs'), '--env.DSH_BUILD_FACE=host'], { cwd: workspaceRoot });
  await run(process.execPath, [join(workspaceRoot, 'node_modules/typescript/bin/tsc'), '--emitDeclarationOnly', '-p', join(packageRoot, 'tsconfig.json')], { cwd: workspaceRoot });
  await run(process.execPath, [join(workspaceRoot, 'node_modules/tsdown/dist/run.mjs')], { cwd: packageRoot });
}, 30_000);

describe('browser plugin publication', () => {
  it('emits one DSH closure bundle with only module-table-safe requires', async () => {
    const source = await readFile(join(packageRoot, 'lib/client.js'), 'utf8');
    expect(source.startsWith('window.__ModuleLoader__.load({ id: "@local/dsh-gpu-model-selection"')).toBe(true);
    expect(source).toContain('ctx.remote.$mount');
    expect(source.match(/ctx\.remote\.\$mount/g)).toHaveLength(1);
    expect(source).toMatch(/package:\s*"@local\/dsh-gpu-workload-manager"/);
    expect(source).toContain('data-plugin-css');
    expect(source).not.toContain('require("@local/dsh-gpu-workload-manager/remote")');
    expect(source).not.toContain('@deepseek-ai/dsh-client-ui-model-selection');
    expect([...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]).sort()).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives',
      'react',
      'react/jsx-runtime',
    ]);
  });

  it('has no runtime edge to the disabled stock selector', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
      dsh: { client: { inject: string[]; external?: string[] } };
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.exports['./package.json']).toBe('./package.json');
    expect(manifest.dsh.client.external).toBeUndefined();
    expect(manifest.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-ui-model-selection');
    expect(manifest.dsh.client.inject).not.toContain('@local/dsh-gpu-workload-manager');
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies['@local/dsh-gpu-workload-manager']).toBe('0.1.0');
    expect(manifest.devDependencies['@local/dsh-gpu-workload-manager']).toBe('workspace:*');
    for (const [name, version] of Object.entries(manifest.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) {
        expect(version, name).toBe('0.1.1-rc.2');
      }
    }
  });

  it('publishes a real Node-side Loader plugin with no default export', async () => {
    const plugin = await import(`${pathToFileURL(join(packageRoot, 'lib/index.js')).href}?test=${Date.now()}`);
    expect(plugin.apply).toBeTypeOf('function');
    expect('default' in plugin).toBe(false);
    const loader = Object.create(Loader.prototype) as Loader;
    expect(loader.unwrapExports(plugin)).toBe(plugin);
  });
});
