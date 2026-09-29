import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
