import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = join(packageRoot, '../..');
const run = promisify(execFile);

beforeAll(async () => {
  await run(process.execPath, [join(workspaceRoot, 'node_modules/typescript/bin/tsc'), '-b', 'tsconfig.host.json'], { cwd: workspaceRoot });
  await run(process.execPath, [join(workspaceRoot, 'node_modules/tsdown/dist/run.mjs'), '--env.DSH_BUILD_FACE=host'], { cwd: workspaceRoot });
}, 30_000);

describe('generated Typert publication', () => {
  it('publishes strict Host and browser Remote artifacts for exactly four methods', async () => {
    const host = await import(pathToFileURL(join(packageRoot, 'lib/typert.host.js')).href) as {
      TYPERT: { package: string; face: string; invocations: readonly Invocation[] };
    };
    const browser = await import(pathToFileURL(join(packageRoot, 'lib/typert.remote-client.js')).href) as {
      default: { package: string; descriptors: readonly Invocation[] };
    };
    const methods = ['cancel', 'models', 'status', 'submit'];

    expect(host.TYPERT.package).toBe('@local/dsh-gpu-workload-manager');
    expect(host.TYPERT.face).toBe('host');
    expect(host.TYPERT.invocations.map(({ namespace, method }) => `${namespace}/${method}`).sort()).toEqual(methods.map((method) => `gpuWorkloads/${method}`));
    expect(browser.default.package).toBe('@local/dsh-gpu-workload-manager');
    expect(browser.default.descriptors.map(({ namespace, method }) => `${namespace}/${method}`).sort()).toEqual(methods.map((method) => `gpuWorkloads/${method}`));
    expect(host.TYPERT.invocations.find(({ method }) => method === 'submit')).toMatchObject({
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict' } }],
      cancellation: { parameter: 'signal' },
      result: { mode: 'strict' },
    });
    expect(host.TYPERT.invocations.find(({ method }) => method === 'status')).toMatchObject({
      parameters: [], cancellation: { parameter: 'signal' }, result: { mode: 'strict' },
    });
  });

  it('declares object-form package exports and all six generated publication files', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.exports).toMatchObject({
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
      './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
    });
    expect(manifest.files).toEqual(expect.arrayContaining([
      'lib/index.js',
      'lib/types/**/*.d.ts',
      'lib/typert.host.js',
      'lib/typert.host.d.ts',
      'lib/typert.remote-client.js',
      'lib/typert.remote-client.d.ts',
    ]));
  });

  it('pins every published runtime and DSH rc.2 peer dependency exactly', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };

    expect(manifest.dependencies.zod).toBe('4.4.3');
    for (const [name, version] of Object.entries(manifest.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) {
        expect(version, name).toBe('0.1.1-rc.2');
      }
    }
  });

  it('keeps the public wire types browser-safe and free of Host imports', async () => {
    const declarations = await readFile(join(packageRoot, 'lib/types/types.d.ts'), 'utf8');
    expect(declarations).not.toMatch(/\b(?:import|export)\b[^;]*\bfrom\b/);
    expect(declarations).not.toContain('@deepseek-ai/dsh-credentials');
    expect(declarations).not.toContain('@deepseek-ai/dsh-commands');
    expect(declarations).toContain('export interface GpuManagerStatus');
  });
});

interface Invocation {
  readonly namespace: string;
  readonly method: string;
  readonly parameters: readonly unknown[];
  readonly cancellation?: { readonly parameter: string };
  readonly result: unknown;
}
