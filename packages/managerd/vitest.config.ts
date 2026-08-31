import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Artifact pins deliberately include ancestor ctime. Running canary and
    // integrity fixtures concurrently under one home mutates that ancestor
    // and turns a security invariant into a test-only race.
    fileParallelism: false,
  },
});
