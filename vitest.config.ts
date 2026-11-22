import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'lib/tests/**/*.test.ts', 'gcp/tests/**/*.test.ts'],
    globals: true,
    environment: 'node',
  },
});
