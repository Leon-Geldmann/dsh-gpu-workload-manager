import { defineConfig } from 'tsdown';
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown';

export default defineConfig(({ env }) => {
  if (env?.DSH_BUILD_FACE !== undefined && env.DSH_BUILD_FACE !== 'host') {
    throw new Error('DSH_BUILD_FACE must be host');
  }
  return {
    workspace: ['packages/dsh-plugin'],
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    plugins: [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  };
});
