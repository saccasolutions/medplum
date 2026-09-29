// Live AccessPolicy tests against a REAL Medplum server.
//   MEDPLUM_BASE_URL=http://localhost:8103 npx vitest run --config test/policies/vitest.live.config.ts
// (from packages/practiceai). Without MEDPLUM_BASE_URL every live suite is skipped.
import { defineConfig } from 'vitest/config';
import { medplumAliases } from '../../../../aliases.mjs';

export default defineConfig({
  resolve: { alias: medplumAliases },
  test: {
    name: '@practiceai/medplum-setup:policies-live',
    root: new URL('../..', import.meta.url).pathname,
    include: ['test/policies/**/*.live.test.ts'],
    globals: true,
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    passWithNoTests: false,
  },
});
