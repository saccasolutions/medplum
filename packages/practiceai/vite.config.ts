import { defineConfig } from 'vitest/config';
import { medplumAliases } from '../../aliases.mjs';

export default defineConfig({
  resolve: {
    alias: medplumAliases,
  },
  test: {
    name: '@practiceai/medplum-setup',
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    passWithNoTests: true,
  },
});
