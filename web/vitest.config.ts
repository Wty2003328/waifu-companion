/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // Globals (describe / it / expect) are imported by name; we don't
    // turn on `globals: true` so the test files stay explicit. Tests
    // that need `expect` import from `vitest`.
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Frontend tests live alongside the code they cover. Match both
    // co-located files (Component.test.tsx) and a single __tests__ dir
    // per directory if you prefer to group them.
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'src/**/__tests__/**/*.{ts,tsx}',
    ],
    // Reasonable timeout. If a test goes over this it's almost
    // certainly waiting on a promise it shouldn't be waiting on.
    testTimeout: 5_000,
  },
});
