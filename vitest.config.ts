import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/{src,test}/**/*.test.ts', 'packages/*/{src,test}/**/*.test.ts'],
    environment: 'node',
  },
});
