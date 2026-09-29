import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The Expo app in mobile/ has its own tests.
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
