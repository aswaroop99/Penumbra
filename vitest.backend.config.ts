import { defineConfig } from 'vitest/config';

// Integration tests that need a running local SpacetimeDB (see test/backend.integration.test.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    fileParallelism: false,
  },
});
