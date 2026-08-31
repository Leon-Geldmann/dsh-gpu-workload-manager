import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/*',
  {
    test: {
      name: 'repository',
      include: ['test/**/*.test.ts'],
      environment: 'node',
    },
  },
]);
