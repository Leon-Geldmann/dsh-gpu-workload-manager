import { defineConfig } from 'tsdown';

const common = {
  outDir: 'dist',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'node22',
  dts: false as const,
  sourcemap: true,
  noExternal: [/^@local\/gpu-workload-core$/],
  outputOptions: { inlineDynamicImports: true },
};

export default defineConfig([
  { ...common, entry: { managerd: 'src/managerd.ts' }, clean: true },
  { ...common, entry: { canary: 'src/canary.ts' }, clean: false },
]);
