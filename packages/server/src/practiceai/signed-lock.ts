// SPDX-License-Identifier: Apache-2.0
/* eslint-disable header/header -- PracticeAI file: no Orangebot copyright line; platform header pending (packages/practiceai/README.md) */
//
// PRACTICEAI (fork-local, not upstream): pure predicates of the PracticeAI signed-content lock.
//
// These mirror the FHIRPath predicates in packages/practiceai/src/policies/lock.ts (LOCK_PREDICATES,
// ENCOUNTER_LINK_PATH) and the constants in packages/practiceai/src/policies/constants.ts. The server must
// not depend on the private practiceai package at runtime, so the logic is duplicated here as plain
// TypeScript; signed-lock.test.ts evaluates the lock.ts FHIRPath on shared fixtures and asserts parity.
// Change both files together.

import type { Project, Reference, Resource } from '@medplum/fhirtypes';

/** Project.systemSetting that turns the server-side guard on for a project (super admin only). */
export const PRACTICEAI_SIGNED_LOCK_SETTING = 'practiceai-signed-lock';

/** Base of all platform-defined FHIR URLs (practiceai constants.ts PLATFORM_FHIR_BASE). */
export const PLATFORM_FHIR_BASE = 'https://practiceai.example/fhir';

/** Encounter signature extension written by the billing app's signEncounter. */
export const ENCOUNTER_SIGNATURE_EXT = `${PLATFORM_FHIR_BASE}/StructureDefinition/encounter-signature`;

/** Security label marking signed clinical content (practiceai constants.ts SIGNED_LOCK_SECURITY). */
export const SIGNED_LOCK_SECURITY = {
  system: `${PLATFORM_FHIR_BASE}/CodeSystem/signed-content-lock`,
  code: 'locked',
} as const;

/** CodeSystem of the `details.coding` in the guard's 403 OperationOutcomes. */
export const LOCK_OUTCOME_SYSTEM = `${PLATFORM_FHIR_BASE}/CodeSystem/signed-lock-outcome`;

/** Clinical resource types protected by the signed-content lock (practiceai lock.ts LOCKABLE_RESOURCE_TYPES). */
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

/** Clinical child types that link to an Encounter (practiceai lock.ts ENCOUNTER_LINK_PATH). */
export const ENCOUNTER_CHILD_TYPES = [
  'Condition',
  'Procedure',
  'Observation',
  'ClinicalImpression',
  'QuestionnaireResponse',
  'DocumentReference',
  'Composition',
] as const;

export function isLockableType(resourceType: string): resourceType is LockableResourceType {
  return (LOCKABLE_RESOURCE_TYPES as readonly string[]).includes(resourceType);
}

export function isEncounterChildType(resourceType: string): boolean {
  return (ENCOUNTER_CHILD_TYPES as readonly string[]).includes(resourceType);
}

/**
 * @param project - The project (may be undefined).
 * @returns True when the project has the PracticeAI signed-content lock enabled.
 */
export function isLockEnabledProject(project: Project | undefined): boolean {
  return (
    project?.systemSetting?.some((s) => s.name === PRACTICEAI_SIGNED_LOCK_SETTING && s.valueBoolean === true) === true
  );
}

export function hasLockLabel(resource: Resource): boolean {
  return (
    resource.meta?.security?.some(
      (s) => s.system === SIGNED_LOCK_SECURITY.system && s.code === SIGNED_LOCK_SECURITY.code
    ) === true
  );
}

/**
 * True when the resource itself is signed/locked: the TypeScript form of lock.ts LOCK_PREDICATES.
 * @param resource - Any resource.
 * @returns True when the resource is a lockable type and is locked by its own content.
 */
export function isSelfLocked(resource: Resource): boolean {
  switch (resource.resourceType) {
    case 'Encounter': {
      const e = resource;
      return (
        e.status === 'finished' || (e.extension ?? []).some((x) => x.url === ENCOUNTER_SIGNATURE_EXT) || hasLockLabel(e)
      );
    }
    case 'DocumentReference': {
      const d = resource;
      return d.docStatus === 'final' || d.docStatus === 'amended' || hasLockLabel(d);
    }
    case 'QuestionnaireResponse': {
      const q = resource;
      return q.status === 'completed' || q.status === 'amended' || hasLockLabel(q);
    }
    case 'Composition': {
      const c = resource;
      return c.status === 'final' || c.status === 'amended' || (c.attester?.length ?? 0) > 0 || hasLockLabel(c);
    }
    case 'Condition':
    case 'Procedure':
    case 'Observation':
    case 'ClinicalImpression':
      return hasLockLabel(resource);
    default:
      return false;
  }
}

/**
 * The encounter link references of a clinical child (`encounter`, or `context.encounter` for DocumentReference).
 * @param resource - Any resource.
 * @returns The reference strings (possibly empty).
 */
export function getEncounterLinkReferences(resource: Resource): string[] {
  let refs: (Reference | undefined)[] = [];
  switch (resource.resourceType) {
    case 'Condition':
    case 'Procedure':
    case 'Observation':
    case 'ClinicalImpression':
    case 'QuestionnaireResponse':
    case 'Composition':
      refs = [(resource as { encounter?: Reference }).encounter];
      break;
    case 'DocumentReference':
      refs = resource.context?.encounter ?? [];
      break;
    default:
      return [];
  }
  return refs.map((r) => r?.reference).filter((r): r is string => typeof r === 'string' && r.length > 0);
}

const ENCOUNTER_REF_RE = /^(?:.*\/)?Encounter\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[^/]+)?$/;

/**
 * Extracts the Encounter id from a reference string (relative, absolute, or versioned).
 * @param reference - Reference string.
 * @returns The id, or undefined when the reference is not a literal Encounter reference.
 */
export function parseEncounterId(reference: string): string | undefined {
  return ENCOUNTER_REF_RE.exec(reference)?.[1];
}

/**
 * The Encounter ids a clinical child links to.
 * @param resource - Any resource.
 * @returns Unique Encounter ids.
 */
export function getLinkedEncounterIds(resource: Resource): string[] {
  const ids = getEncounterLinkReferences(resource)
    .map(parseEncounterId)
    .filter((id): id is string => !!id);
  return [...new Set(ids)];
}

/**
 * Encounter link paths of each child type, with the literal target types FHIR R4 allows there.
 * @param resource - Any resource.
 * @returns The links and allowed target types, or undefined for non-child types.
 */
function getEncounterLinks(resource: Resource): { links: (Reference | undefined)[]; targets: string[] } | undefined {
  switch (resource.resourceType) {
    case 'Condition':
    case 'Procedure':
    case 'Observation':
    case 'ClinicalImpression':
    case 'QuestionnaireResponse':
    case 'Composition':
      return { links: [(resource as { encounter?: Reference }).encounter], targets: ['Encounter'] };
    case 'DocumentReference':
      // R4 DocumentReference.context.encounter is Reference(Encounter | EpisodeOfCare)
      return { links: resource.context?.encounter ?? [], targets: ['Encounter', 'EpisodeOfCare'] };
    default:
      return undefined;
  }
}

/**
 * Server-only rule (stricter than lock.ts, which has no FHIRPath equivalent): in a lock-enabled project every
 * encounter link of a clinical child (`encounter`, DocumentReference `context.encounter`) must be a LITERAL
 * reference (`Encounter/<id>`, absolute or versioned; `EpisodeOfCare/<id>` for DocumentReference). Identifier-only
 * (logical), contained (`#id`), display-only or malformed links are refused, because the guard could not tell
 * whether they designate a signed encounter while consumers resolving by identifier would attach them to it.
 * Conditional (`Encounter?...`) and `urn:uuid` references are rewritten to literal ones before the guard runs.
 * @param resource - Candidate resource.
 * @returns A description of the first non-literal encounter link, or undefined when all links are literal.
 */
export function findNonLiteralEncounterLink(resource: Resource): string | undefined {
  const spec = getEncounterLinks(resource);
  if (!spec) {
    return undefined;
  }
  for (const link of spec.links) {
    if (!link) {
      continue;
    }
    const ref = link.reference;
    if (typeof ref !== 'string' || ref.length === 0) {
      return link.identifier ? 'identifier-only (logical) encounter reference' : 'encounter link without a reference';
    }
    const ok = spec.targets.some((t) =>
      new RegExp(`^(?:.*/)?${t}/[A-Za-z0-9\\-.]{1,64}(?:/_history/[^/]+)?$`).test(ref)
    );
    if (!ok) {
      return `non-literal encounter reference '${ref.slice(0, 80)}'`;
    }
  }
  return undefined;
}

/** Encounter references found anywhere in a resource (see collectEncounterReferences). */
export interface EncounterReferences {
  /** Ids of literal `Encounter/<id>` references (relative, absolute or versioned), in any element. */
  readonly ids: string[];
  /** Identifiers of logical references (no `.reference`) that are or may be Encounter references. */
  readonly identifiers: { system?: string; value: string }[];
}

/**
 * Server-only, broader than lock.ts ENCOUNTER_LINK_PATH: walks the WHOLE resource (every element, including
 * `focus`, `partOf`, extensions, contained resources) and collects every reference that designates an
 * Encounter: literal `Encounter/<id>` references, and Reference identifiers (logical references) whose `type`
 * is `Encounter` or unspecified. The guard treats a clinical child that references a signed
 * encounter in ANY element as belonging to it.
 * @param resource - Any resource.
 * @returns Encounter ids and logical identifiers (deduplicated).
 */
export function collectEncounterReferences(resource: Resource): EncounterReferences {
  const ids = new Set<string>();
  const identifiers = new Map<string, { system?: string; value: string }>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 64 || node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.reference === 'string') {
      const id = parseEncounterId(obj.reference);
      if (id) {
        ids.add(id);
      }
    }
    // A Reference's `identifier` is a single Identifier (a resource's own `identifier` is skipped: the root and
    // contained resources carry `resourceType`). It is collected even next to a literal `reference`, so that
    // {reference: 'Encounter/<draft>', identifier: <signed encounter's business id>} is caught as well.
    if (
      typeof obj.resourceType !== 'string' &&
      obj.identifier &&
      typeof obj.identifier === 'object' &&
      !Array.isArray(obj.identifier) &&
      (obj.type === undefined || obj.type === 'Encounter')
    ) {
      const ident = obj.identifier as { system?: unknown; value?: unknown };
      if (typeof ident.value === 'string' && ident.value.length > 0) {
        const system = typeof ident.system === 'string' && ident.system.length > 0 ? ident.system : undefined;
        identifiers.set(`${system ?? ''}|${ident.value}`, { system, value: ident.value });
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key !== 'meta' && typeof value === 'object') {
        visit(value, depth + 1);
      }
    }
  };
  visit(resource, 0);
  return { ids: [...ids], identifiers: [...identifiers.values()] };
}

/**
 * The shape rule of an addendum (plan AI-03, practiceai lock.ts FINAL_DOC_AUTHORED / ONLY_APPENDS_RELATION /
 * ADDENDUM_BORN_FINAL): a new final DocumentReference with author and date whose every `relatesTo` is `appends`.
 * Whether the target is a signed note of the same encounter is checked by the guard (needs a read).
 * @param resource - Candidate resource.
 * @returns The DocumentReference ids it appends, or undefined when the shape is not an addendum.
 */
export function getAddendumTargets(resource: Resource): string[] | undefined {
  if (resource.resourceType !== 'DocumentReference') {
    return undefined;
  }
  const doc = resource;
  if (doc.docStatus !== 'final' || !doc.author?.length || !doc.date || !doc.relatesTo?.length) {
    return undefined;
  }
  const targets: string[] = [];
  for (const rel of doc.relatesTo) {
    if (rel.code !== 'appends') {
      return undefined;
    }
    const m = /^(?:.*\/)?DocumentReference\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[^/]+)?$/.exec(
      rel.target?.reference ?? ''
    );
    if (!m) {
      return undefined;
    }
    targets.push(m[1]);
  }
  return [...new Set(targets)];
}
