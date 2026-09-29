// SPDX-License-Identifier: Apache-2.0
/* eslint-disable header/header -- PracticeAI file: no Orangebot copyright line; platform header pending (packages/practiceai/README.md) */
//
// PRACTICEAI (fork-local): unit tests of the pure lock predicates, plus parity with the FHIRPath definitions in
// packages/practiceai/src/policies/lock.ts (the AccessPolicy side of the same lock). No database needed.

import { evalFhirPathTyped, toTypedValue } from '@medplum/core';
import type { DocumentReference, Project, Resource } from '@medplum/fhirtypes';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LockReason } from './guard';
import {
  collectEncounterReferences,
  ENCOUNTER_CHILD_TYPES,
  ENCOUNTER_SIGNATURE_EXT,
  findNonLiteralEncounterLink,
  getAddendumTargets,
  getEncounterLinkReferences,
  getLinkedEncounterIds,
  isLockEnabledProject,
  isSelfLocked,
  LOCKABLE_RESOURCE_TYPES,
  parseEncounterId,
  PRACTICEAI_SIGNED_LOCK_SETTING,
  SIGNED_LOCK_SECURITY,
} from './signed-lock';

const LABEL = { meta: { security: [{ ...SIGNED_LOCK_SECURITY }] } };
const OTHER_LABEL = { meta: { security: [{ system: SIGNED_LOCK_SECURITY.system, code: 'other' }] } };
const SIG = { extension: [{ url: ENCOUNTER_SIGNATURE_EXT, extension: [] }] };
const ENC_REF = { reference: 'Encounter/11111111-1111-4111-8111-111111111111' };

/** Shared fixtures: [resource, expected locked]. */
const LOCK_FIXTURES: [Resource, boolean][] = [
  [{ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' } }, false],
  [{ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' } }, true],
  [{ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, ...SIG }, true],
  [{ resourceType: 'Encounter', status: 'planned', class: { code: 'AMB' }, ...LABEL }, true],
  [{ resourceType: 'Encounter', status: 'planned', class: { code: 'AMB' }, ...OTHER_LABEL }, false],
  [
    {
      resourceType: 'Encounter',
      status: 'cancelled',
      class: { code: 'AMB' },
      extension: [{ url: 'x', valueString: 'y' }],
    },
    false,
  ],
  [{ resourceType: 'DocumentReference', status: 'current', content: [], docStatus: 'preliminary' }, false],
  [{ resourceType: 'DocumentReference', status: 'current', content: [] }, false],
  [{ resourceType: 'DocumentReference', status: 'current', content: [], docStatus: 'final' }, true],
  [{ resourceType: 'DocumentReference', status: 'current', content: [], docStatus: 'amended' }, true],
  [{ resourceType: 'DocumentReference', status: 'current', content: [], ...LABEL }, true],
  [{ resourceType: 'QuestionnaireResponse', status: 'in-progress' }, false],
  [{ resourceType: 'QuestionnaireResponse', status: 'completed' }, true],
  [{ resourceType: 'QuestionnaireResponse', status: 'amended' }, true],
  [{ resourceType: 'QuestionnaireResponse', status: 'stopped', ...LABEL }, true],
  [{ resourceType: 'Composition', status: 'preliminary', type: {}, date: '2026-01-01', author: [], title: 't' }, false],
  [{ resourceType: 'Composition', status: 'final', type: {}, date: '2026-01-01', author: [], title: 't' }, true],
  [{ resourceType: 'Composition', status: 'amended', type: {}, date: '2026-01-01', author: [], title: 't' }, true],
  [
    {
      resourceType: 'Composition',
      status: 'preliminary',
      type: {},
      date: '2026-01-01',
      author: [],
      title: 't',
      attester: [{ mode: 'legal' }],
    },
    true,
  ],
  [{ resourceType: 'Condition', subject: { reference: 'Patient/p' } }, false],
  [{ resourceType: 'Condition', subject: { reference: 'Patient/p' }, ...LABEL }, true],
  [{ resourceType: 'Condition', subject: { reference: 'Patient/p' }, ...OTHER_LABEL }, false],
  [{ resourceType: 'Procedure', status: 'completed', subject: { reference: 'Patient/p' } }, false],
  [{ resourceType: 'Procedure', status: 'completed', subject: { reference: 'Patient/p' }, ...LABEL }, true],
  [{ resourceType: 'Observation', status: 'final', code: {} }, false],
  [{ resourceType: 'Observation', status: 'final', code: {}, ...LABEL }, true],
  [{ resourceType: 'ClinicalImpression', status: 'completed', subject: { reference: 'Patient/p' } }, false],
  [{ resourceType: 'ClinicalImpression', status: 'completed', subject: { reference: 'Patient/p' }, ...LABEL }, true],
];

const LINK_FIXTURES: Resource[] = [
  { resourceType: 'Condition', subject: { reference: 'Patient/p' }, encounter: ENC_REF },
  { resourceType: 'Condition', subject: { reference: 'Patient/p' } },
  { resourceType: 'Procedure', status: 'completed', subject: { reference: 'Patient/p' }, encounter: ENC_REF },
  {
    resourceType: 'Observation',
    status: 'final',
    code: {},
    encounter: { reference: 'http://x/fhir/R4/Encounter/abc' },
  },
  { resourceType: 'ClinicalImpression', status: 'completed', subject: { reference: 'Patient/p' }, encounter: ENC_REF },
  { resourceType: 'QuestionnaireResponse', status: 'completed', encounter: ENC_REF },
  { resourceType: 'Composition', status: 'final', type: {}, date: 'd', author: [], title: 't', encounter: ENC_REF },
  {
    resourceType: 'DocumentReference',
    status: 'current',
    content: [],
    context: { encounter: [ENC_REF, { reference: 'Encounter/second' }] },
  },
  { resourceType: 'DocumentReference', status: 'current', content: [] },
];

describe('PracticeAI signed-lock predicates', () => {
  test.each(LOCK_FIXTURES.map(([r, locked], i) => [i, r.resourceType, locked, r] as const))(
    'fixture %i %s locked=%s',
    (_i, _type, locked, resource) => {
      expect(isSelfLocked(resource)).toBe(locked);
    }
  );

  test('non-lockable types are never self-locked', () => {
    expect(isSelfLocked({ resourceType: 'Claim', ...LABEL } as Resource)).toBe(false);
    expect(isSelfLocked({ resourceType: 'Patient', ...LABEL })).toBe(false);
  });

  test('encounter link references', () => {
    expect(getLinkedEncounterIds(LINK_FIXTURES[0])).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(getLinkedEncounterIds(LINK_FIXTURES[1])).toEqual([]);
    expect(getLinkedEncounterIds(LINK_FIXTURES[3])).toEqual(['abc']);
    expect(getLinkedEncounterIds(LINK_FIXTURES[7])).toEqual(['11111111-1111-4111-8111-111111111111', 'second']);
    expect(getLinkedEncounterIds({ resourceType: 'Claim' } as Resource)).toEqual([]);
    expect(parseEncounterId('Encounter/abc/_history/2')).toBe('abc');
    expect(parseEncounterId('Patient/abc')).toBeUndefined();
    expect(parseEncounterId('#contained')).toBeUndefined();
    expect(parseEncounterId('Encounter?identifier=x')).toBeUndefined();
  });

  test('encounter links must be literal (identifier-only / contained / display-only refused)', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const proc = (encounter: unknown): Resource =>
      ({ resourceType: 'Procedure', status: 'completed', subject: {}, encounter }) as Resource;
    expect(findNonLiteralEncounterLink(proc(undefined))).toBeUndefined();
    expect(findNonLiteralEncounterLink(proc({ reference: `Encounter/${id}` }))).toBeUndefined();
    expect(findNonLiteralEncounterLink(proc({ reference: `http://h/fhir/R4/Encounter/${id}/_history/2` }))).toBe(
      undefined
    );
    expect(findNonLiteralEncounterLink(proc({ type: 'Encounter', identifier: { system: 'x', value: id } }))).toMatch(
      /identifier-only/
    );
    expect(findNonLiteralEncounterLink(proc({ display: 'visit' }))).toMatch(/without a reference/);
    expect(findNonLiteralEncounterLink(proc({ reference: '#enc' }))).toMatch(/non-literal/);
    expect(findNonLiteralEncounterLink(proc({ reference: `Patient/${id}` }))).toMatch(/non-literal/);
    const doc = (encounter: unknown[]): Resource =>
      ({ resourceType: 'DocumentReference', status: 'current', content: [], context: { encounter } }) as Resource;
    expect(findNonLiteralEncounterLink(doc([{ reference: `EpisodeOfCare/${id}` }]))).toBeUndefined();
    expect(findNonLiteralEncounterLink(doc([ENC_REF, { identifier: { value: 'ENC-1' } }]))).toMatch(/identifier/);
    // every child type has link rules
    for (const type of ENCOUNTER_CHILD_TYPES) {
      const r = { resourceType: type, encounter: { identifier: { value: 'x' } }, context: { encounter: [{}] } };
      expect({ type, bad: !!findNonLiteralEncounterLink(r as unknown as Resource) }).toEqual({ type, bad: true });
    }
    expect(findNonLiteralEncounterLink({ resourceType: 'Claim' } as Resource)).toBeUndefined();
  });

  test('collectEncounterReferences scans every element (focus, extensions, contained) and logical refs', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const obs = {
      resourceType: 'Observation',
      identifier: [{ system: 'own', value: 'not-a-reference' }],
      status: 'final',
      code: { text: 'x' },
      focus: [{ reference: `Encounter/${id}` }, { reference: 'Patient/p' }],
      extension: [{ url: 'u', valueReference: { reference: `http://h/Encounter/${ENC_REF.reference.slice(10)}` } }],
      derivedFrom: [{ type: 'Encounter', identifier: { system: 'sid', value: 'ENC-7' } }],
      hasMember: [{ type: 'Observation', identifier: { value: 'OBS-1' } }],
      partOf: [{ reference: `Procedure/${id}`, identifier: { value: 'MIXED-1' } }],
      contained: [{ resourceType: 'Procedure', identifier: [{ value: 'c' }], encounter: { reference: `Encounter/${id}` } }],
    } as unknown as Resource;
    const refs = collectEncounterReferences(obs);
    expect(refs.ids.sort()).toEqual([id, ENC_REF.reference.slice(10)].sort());
    expect(refs.identifiers).toEqual(
      expect.arrayContaining([{ system: 'sid', value: 'ENC-7' }, { system: undefined, value: 'MIXED-1' }])
    );
    // typed non-Encounter logical refs and the resource's own identifiers are not collected
    expect(refs.identifiers.map((i) => i.value)).not.toContain('OBS-1');
    expect(refs.identifiers.map((i) => i.value)).not.toContain('not-a-reference');
    expect(refs.identifiers.map((i) => i.value)).not.toContain('c');
  });

  test('addendum shape', () => {
    const base = {
      resourceType: 'DocumentReference',
      status: 'current',
      content: [],
      docStatus: 'final',
      author: [{ reference: 'Practitioner/x' }],
      date: '2026-09-29T00:00:00Z',
      relatesTo: [{ code: 'appends', target: { reference: 'DocumentReference/note-1' } }],
    } satisfies DocumentReference;
    expect(getAddendumTargets(base as Resource)).toEqual(['note-1']);
    expect(getAddendumTargets({ ...base, docStatus: 'preliminary' })).toBeUndefined();
    expect(getAddendumTargets({ ...base, author: undefined })).toBeUndefined();
    expect(getAddendumTargets({ ...base, date: undefined })).toBeUndefined();
    expect(getAddendumTargets({ ...base, relatesTo: undefined })).toBeUndefined();
    expect(
      getAddendumTargets({
        ...base,
        relatesTo: [...base.relatesTo, { code: 'replaces', target: { reference: 'DocumentReference/note-1' } }],
      })
    ).toBeUndefined();
    expect(
      getAddendumTargets({ ...base, relatesTo: [{ code: 'appends', target: { reference: 'Binary/x' } }] })
    ).toBeUndefined();
    expect(getAddendumTargets({ resourceType: 'Condition' } as Resource)).toBeUndefined();
  });

  test('project flag', () => {
    const p = (systemSetting: Project['systemSetting']): Project => ({ resourceType: 'Project', systemSetting });
    expect(isLockEnabledProject(undefined)).toBe(false);
    expect(isLockEnabledProject(p(undefined))).toBe(false);
    expect(isLockEnabledProject(p([{ name: PRACTICEAI_SIGNED_LOCK_SETTING, valueBoolean: true }]))).toBe(true);
    expect(isLockEnabledProject(p([{ name: PRACTICEAI_SIGNED_LOCK_SETTING, valueBoolean: false }]))).toBe(false);
    expect(isLockEnabledProject(p([{ name: PRACTICEAI_SIGNED_LOCK_SETTING, valueString: 'true' }]))).toBe(false);
  });
});

// Parity with packages/practiceai/src/policies/lock.ts. Loaded by path at runtime (not a package dependency, and
// outside this package's tsconfig rootDir); skipped when the fork-local practiceai package is absent.
const lockPath = fileURLToPath(new URL('../../../practiceai/src/policies/lock.ts', import.meta.url));
const constantsPath = fileURLToPath(new URL('../../../practiceai/src/policies/constants.ts', import.meta.url));
const describeParity = existsSync(lockPath) ? describe : describe.skip;

describeParity('parity with packages/practiceai/src/policies/lock.ts', () => {
  let lock: {
    LOCKABLE_RESOURCE_TYPES: readonly string[];
    LOCK_PREDICATES: Record<string, string>;
    ENCOUNTER_LINK_PATH: Record<string, string>;
  };
  let constants: {
    ENCOUNTER_SIGNATURE_EXT: string;
    SIGNED_LOCK_SECURITY: { system: string; code: string };
    SIGNED_LOCK_REASONS: Record<string, string>;
  };

  beforeAll(async () => {
    lock = await import(/* @vite-ignore */ lockPath);
    constants = await import(/* @vite-ignore */ constantsPath);
  });

  test('same constants and lockable types', () => {
    expect(constants.ENCOUNTER_SIGNATURE_EXT).toBe(ENCOUNTER_SIGNATURE_EXT);
    expect(constants.SIGNED_LOCK_SECURITY.system).toBe(SIGNED_LOCK_SECURITY.system);
    expect(constants.SIGNED_LOCK_SECURITY.code).toBe(SIGNED_LOCK_SECURITY.code);
    expect([...lock.LOCKABLE_RESOURCE_TYPES].sort()).toEqual([...LOCKABLE_RESOURCE_TYPES].sort());
    // the reason codes the live suites and the billing gateway match on
    expect(Object.values(constants.SIGNED_LOCK_REASONS).sort()).toEqual(Object.values(LockReason).sort());
  });

  test('every fixture: FHIRPath LOCK_PREDICATES == isSelfLocked', () => {
    const covered = new Set<string>();
    for (const [resource] of LOCK_FIXTURES) {
      const expr = lock.LOCK_PREDICATES[resource.resourceType];
      const out = evalFhirPathTyped(`(${expr}) = true`, [toTypedValue(resource)]);
      const fhirpathLocked = out.length === 1 && out[0].value === true;
      expect({ resource, locked: fhirpathLocked }).toEqual({ resource, locked: isSelfLocked(resource) });
      covered.add(resource.resourceType);
    }
    expect([...covered].sort()).toEqual([...LOCKABLE_RESOURCE_TYPES].sort());
  });

  test('every fixture: ENCOUNTER_LINK_PATH == getEncounterLinkReferences', () => {
    for (const resource of LINK_FIXTURES) {
      const path = lock.ENCOUNTER_LINK_PATH[resource.resourceType];
      const out = evalFhirPathTyped(`${path}.reference`, [toTypedValue(resource)]).map((v) => v.value);
      expect(getEncounterLinkReferences(resource)).toEqual(out);
    }
    expect(Object.keys(lock.ENCOUNTER_LINK_PATH).sort()).toEqual(
      [...new Set(LINK_FIXTURES.map((r) => r.resourceType))].sort()
    );
  });
});
