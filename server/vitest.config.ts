import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/tests/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run test files sequentially: they share one Postgres instance and
    // truncate tables between suites. Parallel file execution would race.
    fileParallelism: false,
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
