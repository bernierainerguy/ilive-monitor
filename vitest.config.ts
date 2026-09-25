import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { buildDefines } from './scripts/build-info';

export default defineConfig({
  plugins: [react()],
  define: buildDefines(),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/ui/**/*.test.tsx'],
    environmentMatchGlobs: [['tests/ui/**', 'jsdom']],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Full-stack screen tests drive real services + disk; shared CI runners are ~3x slower than a dev Mac.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/shared/**', 'src/main/**', 'src/renderer/src/**'],
      exclude: ['src/main/index.ts', 'src/renderer/src/main.tsx'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
