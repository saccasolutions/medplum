// PracticeAI Medplum setup package (placeholder).
// Later work: per-practice Project bootstrap (plan §6.1), role AccessPolicies
// (Provider / Biller / RCM Supervisor / Practice Admin / Front Office / AI Service Identity),
// and signed-documentation protection (ENC-02, AI-03).

/** Default local dev server base URL (see scripts/dev-up.sh). */
export const DEFAULT_MEDPLUM_BASE_URL = 'http://localhost:8103/';

/** Seeded dev super admin (packages/server/src/seed.ts defaults). Dev only. */
export const DEV_SUPER_ADMIN = {
  email: 'admin@example.com',
  password: 'medplum_admin',
} as const;
