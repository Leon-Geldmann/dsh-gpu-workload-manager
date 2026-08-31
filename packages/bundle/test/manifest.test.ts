import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface BundleManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: Record<string, unknown>;
  readonly files?: string[];
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly dsh?: { readonly bundle?: { readonly patch?: string } };
}

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));

describe('dual-role DSH bundle manifest', () => {
  it('publishes one versioned bundle layer with Loader-visible entry points', async () => {
    const manifest = readManifest();
    const module = await import('../src/index.js');

    expect(manifest).toMatchObject({
      name: '@local/dsh-gpu-workload-bundle',
      version: '0.1.0',
      private: false,
      main: './lib/index.js',
      types: './lib/index.d.ts',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    });
    expect(manifest.exports).toEqual({
      '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      './cordis.patch.yml': './cordis.patch.yml',
      './package.json': './package.json',
    });
    expect(manifest.files).toEqual(['lib/index.js', 'lib/index.d.ts', 'lib/index.d.ts.map', 'cordis.patch.yml']);
    expect(module.apply()).toBeUndefined();
  });

  it('pins the DSH compatibility surface and both local occupants exactly', () => {
    const manifest = readManifest();

    expect(manifest.peerDependencies).toEqual({
      '@deepseek-ai/dsh-app-boot': '0.1.1-rc.2',
      '@local/dsh-gpu-model-selection': '0.1.0',
      '@local/dsh-gpu-workload-manager': '0.1.0',
    });
    expect(Object.values(manifest.dependencies ?? {})).not.toContain('workspace:*');
    expect(Object.values(manifest.peerDependencies ?? {}).some((version) => version.startsWith('^') || version.startsWith('~'))).toBe(false);
    expect(manifest.devDependencies).toEqual({
      '@deepseek-ai/dsh-app-boot': '0.1.1-rc.2',
      '@local/dsh-gpu-model-selection': '0.1.0',
      '@local/dsh-gpu-workload-manager': '0.1.0',
    });
  });
});

function readManifest(): BundleManifest {
  return JSON.parse(readFileSync(packagePath, 'utf8')) as BundleManifest;
}
