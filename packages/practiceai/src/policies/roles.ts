// Role AccessPolicy builders (plan §6.1). One set per practice Medplum project.
//
// Design rules (verified against the running server in test/policies/*.live.test.ts):
//  - Explicit resource-type allow lists, never '*'. Anything not listed is denied (403 on write,
//    403/empty on read). AccessPolicy, ClientApplication, Bot, Subscription, ProjectMembership etc. are
//    therefore never writable by a practice identity.
//  - No role gets `delete` on clinical or financial resources. Retire with status instead (history kept).
//  - Every writable entry of a lockable clinical type carries the signed-content lock (./lock.ts).
//  - Binary is create/read only: a Binary referenced by a signed document must never be overwritten.
//  - Memberships using these policies must have `admin: false`. Project admins can $expunge any resource
//    in the project and rewrite ProjectMembership.accessPolicy, which bypasses AccessPolicies entirely
//    (see README "Who bypasses AccessPolicy").

import type { AccessPolicy, AccessPolicyResource } from '@medplum/fhirtypes';
import type { PracticeRole } from './constants';
import { ACCESS_POLICY_IDENTIFIER_SYSTEM, PRACTICE_ROLES, ROLE_TITLES } from './constants';
import type { LockableResourceType } from './lock';
import { READ_ONLY, WRITE_NO_DELETE, lockedEntry, toWriteConstraints } from './lock';

export interface PracticePolicyOptions {
  /** The practice's Medplum project id. The policy is created inside this project (meta.project). */
  readonly projectId: string;
  /** Optional opaque practice label for the policy description (never a patient/person name). */
  readonly practiceLabel?: string;
}

// ---------------------------------------------------------------- resource groups

/** Signed-documentation / chart types. */
export const CLINICAL_NOTE_TYPES: LockableResourceType[] = [
  'Encounter',
  'Condition',
  'Procedure',
  'Observation',
  'ClinicalImpression',
  'QuestionnaireResponse',
  'DocumentReference',
  'Composition',
];

/** Other clinical context readable by clinical/billing roles (not locked, not writable by non-providers). */
export const CLINICAL_CONTEXT_TYPES = [
  'AllergyIntolerance',
  'CarePlan',
  'Goal',
  'ServiceRequest',
  'MedicationStatement',
];

export const DEMOGRAPHIC_TYPES = ['Patient', 'RelatedPerson'];
export const SCHEDULING_TYPES = ['Appointment', 'Schedule', 'Slot'];
export const DIRECTORY_TYPES = ['Practitioner', 'PractitionerRole', 'Organization', 'Location', 'HealthcareService'];
export const FINANCIAL_TYPES = [
  'Claim',
  'ClaimResponse',
  'ExplanationOfBenefit',
  'Account',
  'ChargeItem',
  'Invoice',
  'PaymentNotice',
  'PaymentReconciliation',
  'CoverageEligibilityRequest',
  'CoverageEligibilityResponse',
];
export const WORKFLOW_TYPES = ['Task', 'Communication', 'DetectedIssue'];
export const REFERENCE_TYPES = ['Questionnaire', 'ValueSet', 'CodeSystem'];

// ---------------------------------------------------------------- entry helpers

function ro(resourceType: string, extra: Partial<AccessPolicyResource> = {}): AccessPolicyResource {
  return { resourceType, interaction: [...READ_ONLY], ...extra };
}

function rw(resourceType: string, extra: Partial<AccessPolicyResource> = {}): AccessPolicyResource {
  return { resourceType, interaction: [...WRITE_NO_DELETE], ...extra };
}

const binaryCreateRead: AccessPolicyResource = { resourceType: 'Binary', interaction: ['create', 'read', 'vread'] };
const binaryRead: AccessPolicyResource = { resourceType: 'Binary', interaction: ['read', 'vread'] };

/** Coverage cannot be moved to another patient. (readonlyFields would blank `beneficiary` on create.) */
const COVERAGE_BENEFICIARY_IMMUTABLE =
  '%before.exists().not() or %before.beneficiary.reference = %after.beneficiary.reference';

/** AI may only create / edit Claim drafts, never submit or change a non-draft claim. */
const CLAIM_DRAFT_ONLY = ["%after.status = 'draft'", "%before.exists().not() or %before.status = 'draft'"];

// ---------------------------------------------------------------- role resource lists

function providerResources(): AccessPolicyResource[] {
  return [
    // Own encounters: document and sign (transition to 'finished'). Criteria are checked on the stored and
    // the new version, so a provider can neither edit another provider's encounter nor reassign it.
    lockedEntry('Encounter', { criteria: 'Encounter?participant=%profile' }),
    ro('Encounter'),
    lockedEntry('Condition'),
    lockedEntry('Procedure'),
    lockedEntry('Observation'),
    lockedEntry('ClinicalImpression'),
    lockedEntry('QuestionnaireResponse', { criteria: 'QuestionnaireResponse?author=%profile' }),
    ro('QuestionnaireResponse'),
    // Notes and addenda: only authored by the provider themself; immutable once final.
    lockedEntry('DocumentReference', { criteria: 'DocumentReference?author=%profile' }),
    ro('DocumentReference'),
    lockedEntry('Composition', { criteria: 'Composition?author=%profile' }),
    ro('Composition'),
    ...CLINICAL_CONTEXT_TYPES.map((t) => rw(t)),
    ...DEMOGRAPHIC_TYPES.map((t) => ro(t)),
    ro('Coverage'),
    ...SCHEDULING_TYPES.map((t) => ro(t)),
    ...DIRECTORY_TYPES.map((t) => ro(t)),
    ro('Claim'),
    ro('ClaimResponse'),
    rw('Task'),
    rw('Communication'),
    ro('DetectedIssue'),
    ...REFERENCE_TYPES.map((t) => ro(t)),
    binaryCreateRead,
  ];
}

function frontOfficeResources(): AccessPolicyResource[] {
  return [
    ...DEMOGRAPHIC_TYPES.map((t) => rw(t)),
    rw('Coverage', { writeConstraint: toWriteConstraints([COVERAGE_BENEFICIARY_IMMUTABLE]) }),
    ...SCHEDULING_TYPES.map((t) => rw(t)),
    rw('CoverageEligibilityRequest'),
    ro('CoverageEligibilityResponse'),
    // Visit list only: no diagnoses / reasons, and no access at all to notes, conditions, procedures.
    ro('Encounter', { hiddenFields: ['diagnosis', 'reasonCode', 'reasonReference', 'extension'] }),
    ...DIRECTORY_TYPES.map((t) => ro(t)),
    rw('Task'),
    rw('Communication'),
    ro('ValueSet'),
    ro('CodeSystem'),
    binaryCreateRead, // insurance card / ID scans
  ];
}

function billerResources(): AccessPolicyResource[] {
  return [
    // Clinical: read only (cannot alter signed documentation, plan §6.1).
    ...CLINICAL_NOTE_TYPES.map((t) => ro(t)),
    ...CLINICAL_CONTEXT_TYPES.map((t) => ro(t)),
    ...DEMOGRAPHIC_TYPES.map((t) => ro(t)),
    rw('Coverage', { writeConstraint: toWriteConstraints([COVERAGE_BENEFICIARY_IMMUTABLE]) }),
    ...FINANCIAL_TYPES.map((t) => rw(t)),
    ...SCHEDULING_TYPES.map((t) => ro(t)),
    ...DIRECTORY_TYPES.map((t) => ro(t)),
    rw('Task'),
    rw('Communication'),
    ro('DetectedIssue'),
    ...REFERENCE_TYPES.map((t) => ro(t)),
    binaryRead,
  ];
}

function rcmSupervisorResources(): AccessPolicyResource[] {
  return [
    ...billerResources().filter((r) => r.resourceType !== 'DetectedIssue'),
    // Supervisors disposition AI findings.
    rw('DetectedIssue'),
    ro('AuditEvent'),
  ];
}

function practiceAdminResources(): AccessPolicyResource[] {
  return [
    // Oversight read of the chart, no clinical edits.
    ...CLINICAL_NOTE_TYPES.map((t) => ro(t)),
    ...CLINICAL_CONTEXT_TYPES.map((t) => ro(t)),
    ...DEMOGRAPHIC_TYPES.map((t) => ro(t)),
    ro('Coverage'),
    ...SCHEDULING_TYPES.map((t) => rw(t)),
    ...FINANCIAL_TYPES.map((t) => ro(t)),
    // Practice directory (providers, locations, organization) is managed by the admin.
    ...DIRECTORY_TYPES.map((t) => rw(t)),
    ...WORKFLOW_TYPES.map((t) => ro(t)),
    rw('Task'),
    ro('AuditEvent'),
    ro('AccessPolicy'),
    ro('ClientApplication', { hiddenFields: ['secret', 'retiringSecret'] }),
    ...REFERENCE_TYPES.map((t) => ro(t)),
    binaryRead,
  ];
}

function aiServiceResources(): AccessPolicyResource[] {
  return [
    // Read only the resources needed for coding / scrubbing / documentation QA.
    ...CLINICAL_NOTE_TYPES.map((t) => ro(t)),
    ro('Patient', { hiddenFields: ['photo', 'telecom', 'contact'] }),
    ro('Coverage'),
    ...DIRECTORY_TYPES.map((t) => ro(t)),
    ro('ClaimResponse'),
    ro('Questionnaire'),
    binaryRead,
    // Whitelisted writes: claim drafts and workflow objects for findings. Never clinical content.
    rw('Claim', { writeConstraint: toWriteConstraints(CLAIM_DRAFT_ONLY) }),
    rw('Task'),
    rw('Communication'),
    rw('DetectedIssue'),
  ];
}

function integrationResources(): AccessPolicyResource[] {
  // The billing platform server (MEDPLUM_PROJECTS clientId). Matches SUPPORTED_RESOURCE_TYPES in the app,
  // plus workflow types. Clinical writes are allowed only while unsigned; nothing may be deleted.
  return [
    rw('Patient'),
    rw('RelatedPerson'),
    ro('Practitioner'),
    ro('PractitionerRole'),
    rw('Organization'),
    ro('Location'),
    rw('Coverage', { writeConstraint: toWriteConstraints([COVERAGE_BENEFICIARY_IMMUTABLE]) }),
    ...CLINICAL_NOTE_TYPES.map((t) => lockedEntry(t)),
    ...FINANCIAL_TYPES.map((t) => rw(t)),
    ...WORKFLOW_TYPES.map((t) => rw(t)),
    ...SCHEDULING_TYPES.map((t) => ro(t)),
    ...REFERENCE_TYPES.map((t) => ro(t)),
    binaryCreateRead,
  ];
}

const RESOURCE_BUILDERS: Record<PracticeRole, () => AccessPolicyResource[]> = {
  provider: providerResources,
  front_office: frontOfficeResources,
  biller: billerResources,
  rcm_supervisor: rcmSupervisorResources,
  practice_admin: practiceAdminResources,
  ai_service: aiServiceResources,
  integration: integrationResources,
};

const ROLE_DESCRIPTIONS: Record<PracticeRole, string> = {
  provider: 'Document and sign own encounters; author addenda. Signed content is immutable.',
  front_office: 'Patient, coverage and scheduling. No clinical notes.',
  biller: 'Read-only clinical; writes claims, remittances and coverage admin fields.',
  rcm_supervisor: 'Biller permissions plus disposition of AI findings and audit read.',
  practice_admin: 'Practice directory and scheduling; read-only chart; no clinical edits.',
  ai_service: 'Reads permitted resources; writes only Claim drafts, Task, Communication, DetectedIssue.',
  integration: 'Billing platform server client. Clinical writes only while unsigned; no deletes.',
};

/**
 * Builds the AccessPolicy for one role in one practice project.
 * @param role - The PracticeAI role.
 * @param options - Optional settings.
 * @returns The AccessPolicy for the role.
 */
export function buildRolePolicy(role: PracticeRole, options: PracticePolicyOptions): AccessPolicy {
  if (!options.projectId) {
    throw new Error('projectId is required');
  }
  const label = options.practiceLabel ? ` (${options.practiceLabel})` : '';
  return {
    resourceType: 'AccessPolicy',
    meta: { project: options.projectId },
    name: `PracticeAI ${ROLE_TITLES[role]}${label}`,
    resource: RESOURCE_BUILDERS[role](),
    extension: [
      { url: ACCESS_POLICY_IDENTIFIER_SYSTEM, valueCode: role },
      { url: `${ACCESS_POLICY_IDENTIFIER_SYSTEM}-description`, valueString: ROLE_DESCRIPTIONS[role] },
    ],
  };
}

export const buildProviderPolicy = (o: PracticePolicyOptions): AccessPolicy => buildRolePolicy('provider', o);
export const buildFrontOfficePolicy = (o: PracticePolicyOptions): AccessPolicy => buildRolePolicy('front_office', o);
export const buildBillerPolicy = (o: PracticePolicyOptions): AccessPolicy => buildRolePolicy('biller', o);
export const buildRcmSupervisorPolicy = (o: PracticePolicyOptions): AccessPolicy =>
  buildRolePolicy('rcm_supervisor', o);
export const buildPracticeAdminPolicy = (o: PracticePolicyOptions): AccessPolicy =>
  buildRolePolicy('practice_admin', o);
export const buildAiServicePolicy = (o: PracticePolicyOptions): AccessPolicy => buildRolePolicy('ai_service', o);
export const buildIntegrationClientPolicy = (o: PracticePolicyOptions): AccessPolicy =>
  buildRolePolicy('integration', o);

/**
 * Builds every role policy for a practice project.
 * @param options - Optional settings.
 * @returns AccessPolicy per role.
 */
export function buildPracticePolicies(options: PracticePolicyOptions): Record<PracticeRole, AccessPolicy> {
  return Object.fromEntries(PRACTICE_ROLES.map((r) => [r, buildRolePolicy(r, options)])) as Record<
    PracticeRole,
    AccessPolicy
  >;
}

/**
 * Reads the PracticeAI role code off a policy built by buildRolePolicy.
 * @param policy - The role AccessPolicy.
 * @returns The role code, if present.
 */
export function roleOfPolicy(policy: AccessPolicy): PracticeRole | undefined {
  return policy.extension?.find((e) => e.url === ACCESS_POLICY_IDENTIFIER_SYSTEM)?.valueCode as
    PracticeRole | undefined;
}
