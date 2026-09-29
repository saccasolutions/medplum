// Signed-encounter lock (plan §4, ENC-02, AI-03) expressed as Medplum AccessPolicy writeConstraints.
//
// Semantics (packages/server/src/fhir/repo.ts, isResourceWriteable):
//  - writeConstraint is evaluated on create and update (incl. PATCH, batch/transaction entries, GraphQL
//    mutations), after the candidate resource is built. `%before` is the stored version (empty on create),
//    `%after` the version that would be written. Every constraint must evaluate to exactly `true`.
//  - Only the FIRST resource entry that matches the interaction + criteria is used, so every writable entry
//    of a lockable type must carry the lock constraints (the role builders use lockedEntry()).
//  - writeConstraint is NOT evaluated on delete. Deletion is controlled by the `interaction` list; no
//    PracticeAI policy grants `delete` on clinical resource types (the billing app never deletes; draft
//    lines are retired with status entered-in-error).
//  - A no-op PUT (identical content) returns the stored version without evaluating constraints.

import type { AccessPolicyResource, Bundle, BundleEntry, Resource } from '@medplum/fhirtypes';
import { ENCOUNTER_SIGNATURE_EXT, SIGNED_LOCK_SECURITY } from './constants';

/** Clinical resource types that are protected by the signed-content lock. */
export const LOCKABLE_RESOURCE_TYPES = [
  'Encounter',
  'Condition',
  'Procedure',
  'Observation',
  'ClinicalImpression',
  'QuestionnaireResponse',
  'DocumentReference',
  'Composition',
] as const;
export type LockableResourceType = (typeof LOCKABLE_RESOURCE_TYPES)[number];

const TAG = `meta.security.where(system = '${SIGNED_LOCK_SECURITY.system}' and code = '${SIGNED_LOCK_SECURITY.code}').exists()`;

/**
 * FHIRPath predicate (evaluated on a resource) that is true when the resource is signed/locked.
 * Written so that missing fields evaluate as "not locked" instead of an empty collection.
 */
export const LOCK_PREDICATES: Record<LockableResourceType, string> = {
  // The app signs by PUTting status 'finished' + the signature extension in one transaction.
  Encounter: `status = 'finished' or extension.where(url = '${ENCOUNTER_SIGNATURE_EXT}').exists() or ${TAG}`,
  // Signed note and addenda are written with docStatus 'final'. 'amended' is treated as signed too, so a
  // document can never escape the lock by being written as amended.
  DocumentReference: `docStatus = 'final' or docStatus = 'amended' or ${TAG}`,
  // The SOAP QuestionnaireResponse becomes 'completed' in the signing transaction.
  QuestionnaireResponse: `status = 'completed' or status = 'amended' or ${TAG}`,
  Composition: `status = 'final' or status = 'amended' or attester.exists() or ${TAG}`,
  // No "signed" status exists for these; they are locked via the security label.
  Condition: TAG,
  Procedure: TAG,
  Observation: TAG,
  ClinicalImpression: TAG,
};

function fhirpath(expression: string): { language: 'text/fhirpath'; expression: string } {
  return { language: 'text/fhirpath', expression };
}

/**
 * Constraint: the stored version must not be locked. Blocks every update, patch and status revert.
 * @param resourceType - The lockable clinical resource type.
 * @returns FHIRPath expression that is true when %before is absent or not locked.
 */
export function notLockedConstraint(resourceType: LockableResourceType): string {
  return `%before.exists().not() or %before.where(${LOCK_PREDICATES[resourceType]}).exists().not()`;
}

/** Constraint: a clinical record may not be moved to another patient once written. */
export const SUBJECT_IMMUTABLE =
  '%before.exists().not() or %before.subject.reference.exists().not() or %before.subject.reference = %after.subject.reference';

/** Constraint: encounters are finalized only by transitioning an existing draft (never created signed). */
export const ENCOUNTER_NOT_CREATED_SIGNED = `%before.exists() or %after.where(status = 'finished' or extension.where(url = '${ENCOUNTER_SIGNATURE_EXT}').exists()).exists().not()`;

/** Constraint: a final DocumentReference (signed note or addendum) must be separately authored and timestamped. */
export const FINAL_DOC_AUTHORED = `%after.where(docStatus = 'final').exists().not() or (%after.author.exists() and %after.date.exists())`;

/**
 * Constraint: the only allowed relationship to another document is `appends` (addendum). `replaces` /
 * `transforms` / `signs` would let a new document supersede signed content.
 */
export const ONLY_APPENDS_RELATION = `%after.relatesTo.where(code != 'appends').exists().not()`;

/**
 * Constraint: an addendum (any DocumentReference that relates to another document) must be written final,
 * so it is locked from its first version. Otherwise a 'preliminary' document that `appends` the signed note
 * would be listed as an addendum by the app while staying silently editable (AI-03).
 */
export const ADDENDUM_BORN_FINAL = `%after.relatesTo.exists().not() or %after.docStatus = 'final'`;

/** FHIRPath of the element that links each lockable child type to its Encounter. */
export const ENCOUNTER_LINK_PATH: Partial<Record<LockableResourceType, string>> = {
  Condition: 'encounter',
  Procedure: 'encounter',
  Observation: 'encounter',
  ClinicalImpression: 'encounter',
  QuestionnaireResponse: 'encounter',
  Composition: 'encounter',
  DocumentReference: 'context.encounter',
};

/**
 * Constraint: once written, a clinical child record cannot be re-linked to another encounter (or have its
 * encounter link added or removed). Prevents moving a draft Procedure/Condition into an already-signed
 * encounter, or moving content out of one. (Creating a NEW child that references a signed encounter cannot be
 * blocked by an AccessPolicy: FHIRPath cannot dereference the Encounter. See README "Known gaps".)
 * @param path - FHIRPath of the encounter reference element.
 * @returns FHIRPath expression.
 */
export function encounterLinkImmutable(path: string): string {
  const before = `%before.${path}.reference`;
  const after = `%after.${path}.reference`;
  return `%before.exists().not() or (${before}.exists().not() and ${after}.exists().not()) or (${before}.count() = ${after}.count() and ${before} = ${after})`;
}

/**
 * All write constraints for a lockable type.
 * @param resourceType - The lockable clinical resource type.
 * @returns FHIRPath expressions for every lock rule of the type.
 */
export function lockConstraints(resourceType: LockableResourceType): string[] {
  const out = [notLockedConstraint(resourceType), SUBJECT_IMMUTABLE];
  const link = ENCOUNTER_LINK_PATH[resourceType];
  if (link) {
    out.push(encounterLinkImmutable(link));
  }
  if (resourceType === 'Encounter') {
    out.push(ENCOUNTER_NOT_CREATED_SIGNED);
  }
  if (resourceType === 'DocumentReference') {
    out.push(FINAL_DOC_AUTHORED, ONLY_APPENDS_RELATION, ADDENDUM_BORN_FINAL);
  }
  return out;
}

/** Interactions for a writable clinical entry: everything except delete. */
export const WRITE_NO_DELETE: NonNullable<AccessPolicyResource['interaction']> = [
  'create',
  'read',
  'vread',
  'update',
  'search',
  'history',
];

export const READ_ONLY: NonNullable<AccessPolicyResource['interaction']> = ['read', 'vread', 'search', 'history'];

export function isLockable(resourceType: string): resourceType is LockableResourceType {
  return (LOCKABLE_RESOURCE_TYPES as readonly string[]).includes(resourceType);
}

/**
 * A writable (create/update, never delete) entry for a lockable clinical type, carrying the lock
 * constraints plus any extra constraints.
 * @param resourceType - The lockable clinical resource type.
 * @param options - Optional settings.
 * @param options.criteria - Optional search criteria restricting which resources the entry covers.
 * @param options.extraConstraints - Additional FHIRPath write constraints.
 * @returns The AccessPolicy resource entry.
 */
export function lockedEntry(
  resourceType: LockableResourceType,
  options: { criteria?: string; extraConstraints?: string[] } = {}
): AccessPolicyResource {
  return {
    resourceType,
    ...(options.criteria ? { criteria: options.criteria } : {}),
    interaction: [...WRITE_NO_DELETE],
    writeConstraint: [...lockConstraints(resourceType), ...(options.extraConstraints ?? [])].map(fhirpath),
  };
}

/**
 * Wrap raw FHIRPath expressions as AccessPolicy writeConstraint expressions.
 * @param expressions - Raw FHIRPath expressions.
 * @returns AccessPolicy writeConstraint expressions.
 */
export function toWriteConstraints(expressions: string[]): NonNullable<AccessPolicyResource['writeConstraint']> {
  return expressions.map(fhirpath);
}

/**
 * Returns a copy of the resource with the signed-content lock security label added (idempotent).
 * @param resource - The resource to label.
 * @returns A copy of the resource carrying the lock label.
 */
export function withLockLabel<T extends Resource>(resource: T): T {
  const security = resource.meta?.security ?? [];
  if (security.some((s) => s.system === SIGNED_LOCK_SECURITY.system && s.code === SIGNED_LOCK_SECURITY.code)) {
    return resource;
  }
  return {
    ...resource,
    meta: { ...resource.meta, security: [...security, { ...SIGNED_LOCK_SECURITY }] },
  };
}

/**
 * Builds the extra transaction entries the signing transaction should include so that Condition /
 * Procedure / Observation / ClinicalImpression resources of the signed encounter become immutable
 * on the server (they have no status that means "signed"). Pass the current versions; each entry is a
 * PUT guarded by If-Match on the version that was signed.
 * @param children - Current versions of the encounter's clinical child resources.
 * @returns Transaction entries (PUT with If-Match) that apply the lock label.
 */
export function buildSignLockEntries(children: Resource[]): BundleEntry[] {
  return children
    .filter((r) => r.id && isLockable(r.resourceType))
    .map((r) => ({
      resource: withLockLabel(r),
      request: {
        method: 'PUT',
        url: `${r.resourceType}/${r.id}`,
        ...(r.meta?.versionId ? { ifMatch: `W/"${r.meta.versionId}"` } : {}),
      },
    }));
}

/**
 * Convenience: wrap entries as a FHIR transaction bundle.
 * @param entries - Bundle entries.
 * @returns A transaction Bundle.
 */
export function transactionBundle(entries: BundleEntry[]): Bundle {
  return { resourceType: 'Bundle', type: 'transaction', entry: entries };
}
