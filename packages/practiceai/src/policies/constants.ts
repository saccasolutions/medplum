// PracticeAI access-policy constants.
//
// URLs / codes MUST stay in sync with the billing app's FHIR mapping
// (billing repo: src/lib/fhir/constants.ts, src/lib/fhir/pt-note.ts, src/lib/fhir/gateway-core.ts),
// otherwise the server-side lock would not recognise what the app writes.

/** Base of all platform-defined FHIR URLs (billing: PLATFORM_FHIR_BASE). */
export const PLATFORM_FHIR_BASE = 'https://practiceai.example/fhir';

/** Encounter signature extension written by the app's signEncounter (billing: EXT.signature). */
export const ENCOUNTER_SIGNATURE_EXT = `${PLATFORM_FHIR_BASE}/StructureDefinition/encounter-signature`;

/** DocumentReference content hash extension (billing: EXT.contentHash). */
export const CONTENT_HASH_EXT = `${PLATFORM_FHIR_BASE}/StructureDefinition/content-sha256`;

/** Identifier system the app uses for note lines (billing: SYSTEMS.noteLine). */
export const NOTE_LINE_SYSTEM = `${PLATFORM_FHIR_BASE}/sid/note-line`;

/** LOINC codes used for the signed note and addenda (billing: LOINC). */
export const LOINC_SYSTEM = 'http://loinc.org';
export const LOINC_PROGRESS_NOTE = '11506-3';
export const LOINC_ADDENDUM = '55107-7';

/**
 * Security label that marks a clinical resource as part of signed documentation.
 *
 * Encounter / DocumentReference / QuestionnaireResponse / Composition are recognised as signed from
 * their own status fields. Condition, Procedure, Observation and ClinicalImpression have no status that
 * means "signed", so they are locked only when they carry this label. The signing transaction is expected
 * to stamp it on every clinical child of the encounter (see buildSignLockEntries in ./lock.ts).
 */
export const SIGNED_LOCK_SECURITY = {
  system: `${PLATFORM_FHIR_BASE}/CodeSystem/signed-content-lock`,
  code: 'locked',
  display: 'Signed clinical content (immutable)',
} as const;

/** Identifier system used to find/upsert the PracticeAI AccessPolicies inside a project. */
export const ACCESS_POLICY_IDENTIFIER_SYSTEM = `${PLATFORM_FHIR_BASE}/sid/access-policy`;

/** Roles from plan §6.1 plus the billing-app integration client. */
export const PRACTICE_ROLES = [
  'provider',
  'front_office',
  'biller',
  'rcm_supervisor',
  'practice_admin',
  'ai_service',
  'integration',
] as const;
export type PracticeRole = (typeof PRACTICE_ROLES)[number];

/** Human-readable role names (used for AccessPolicy.name). */
export const ROLE_TITLES: Record<PracticeRole, string> = {
  provider: 'Provider',
  front_office: 'Front Office',
  biller: 'Biller',
  rcm_supervisor: 'RCM Supervisor',
  practice_admin: 'Practice Admin',
  ai_service: 'AI Service Identity',
  integration: 'Billing Platform Integration Client',
};
