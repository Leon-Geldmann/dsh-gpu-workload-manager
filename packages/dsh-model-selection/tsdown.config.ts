import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'lightningcss';
import { defineConfig } from 'tsdown';

const PACKAGE_ID = '@local/dsh-gpu-model-selection';
const CSS_PREFIX = '\0gpu-model-css:';
const CSS_SUFFIX = '.mjs';
const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url));
const EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
]);

export default defineConfig([
  {
    name: PACKAGE_ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
  },
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      name: 'gpu-generated-remote-inline',
      resolveId: {
        order: 'pre',
        handler(source: string) {
          if (source !== '@local/dsh-gpu-workload-manager/remote') return null;
          return resolve(PACKAGE_DIR, '../dsh-plugin/lib/typert.remote-client.js');
        },
      },
    }, {
      name: 'gpu-model-css-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.css') || importer === undefined) return null;
        return `${CSS_PREFIX}${resolve(importer, '..', source)}${CSS_SUFFIX}`;
      },
      async load(id: string) {
        if (!id.startsWith(CSS_PREFIX)) return null;
        const file = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length);
        this.addWatchFile(file);
        const result = transform({ filename: file, code: await readFile(file), minify: true });
        const css = result.code.toString();
        const tagId = `${PACKAGE_ID}/styles.css`;
        return [
          `const css = ${JSON.stringify(css)};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
          "  const tag = document.createElement('style');",
          `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          'export {};',
        ].join('\n');
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]);
