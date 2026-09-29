// Offline unit tests for the policy builders (no server needed). The live suites verify the same
// rules end to end against a running server.

import { evalFhirPathTyped, indexSearchParameterBundle, satisfiedAccessPolicy, toTypedValue } from '@medplum/core';
// @medplum/definitions is a workspace package (hoisted); used only to index search params for criteria matching.
import { readJson } from '@medplum/definitions';
import type { AccessPolicy, AccessPolicyResource, Bundle, Resource, SearchParameter } from '@medplum/fhirtypes';
import {
  ENCOUNTER_SIGNATURE_EXT,
  LOCKABLE_RESOURCE_TYPES,
  PRACTICE_ROLES,
  SIGNED_LOCK_SECURITY,
  buildPracticePolicies,
  buildRolePolicy,
  buildSignLockEntries,
  isLockable,
  roleOfPolicy,
  withLockLabel,
} from '../../src/policies';

beforeAll(() => {
  indexSearchParameterBundle(readJson('fhir/r4/search-parameters.json') as Bundle<SearchParameter>);
});

const PROJECT = '00000000-0000-4000-8000-000000000001';
const policies = buildPracticePolicies({ projectId: PROJECT });

/**
 * Mirrors Repository.isResourceWriteable: first matching entry, every constraint must be exactly true.
 * @param policy - The role AccessPolicy.
 * @param before - The stored version (undefined on create).
 * @param after - The candidate version to write.
 * @returns The result of writable.
 */
function writable(policy: AccessPolicy, before: Resource | undefined, after: Resource): boolean {
  const entry = satisfiedAccessPolicy(after, before ? 'update' : 'create', policy);
  if (!entry) {
    return false;
  }
  return (entry.writeConstraint ?? []).every((c) => {
    const out = evalFhirPathTyped(c.expression as string, [toTypedValue(after)], {
      '%before': { type: before?.resourceType ?? 'undefined', value: before },
      '%after': toTypedValue(after),
    });
    return out.length === 1 && out[0].value === true;
  });
}

const integ = policies.integration;
const enc = (extra: object = {}): any => ({
  resourceType: 'Encounter',
  id: 'e1',
  status: 'in-progress',
  class: { code: 'AMB' },
  subject: { reference: 'Patient/p1' },
  ...extra,
});

describe('policy structure', () => {
  test('one policy per role, created in the practice project', () => {
    expect(Object.keys(policies).sort()).toEqual([...PRACTICE_ROLES].sort());
    for (const role of PRACTICE_ROLES) {
      expect(policies[role].meta?.project).toBe(PROJECT);
      expect(roleOfPolicy(policies[role])).toBe(role);
    }
    expect(() => buildRolePolicy('biller', { projectId: '' })).toThrow();
  });

  test('no wildcard entries and no admin resource types', () => {
    for (const p of Object.values(policies)) {
      for (const r of p.resource ?? []) {
        expect(r.resourceType).not.toBe('*');
        expect(['ProjectMembership', 'Project', 'User', 'Bot', 'Subscription']).not.toContain(r.resourceType);
      }
    }
  });

  test('no role may delete any clinical or financial resource, or Binary', () => {
    for (const [role, p] of Object.entries(policies)) {
      for (const r of p.resource ?? []) {
        expect(r.interaction, `${role} ${r.resourceType} must list interactions`).toBeDefined();
        if (
          isLockable(r.resourceType) ||
          ['Claim', 'ClaimResponse', 'Coverage', 'Patient', 'Binary'].includes(r.resourceType)
        ) {
          expect(r.interaction, `${role} ${r.resourceType}`).not.toContain('delete');
        }
      }
    }
  });

  test('every writable entry of a lockable type carries the lock constraint', () => {
    for (const [role, p] of Object.entries(policies)) {
      for (const r of p.resource ?? []) {
        const writes = r.interaction?.some((i) => i === 'create' || i === 'update');
        if (isLockable(r.resourceType) && writes) {
          const exprs = (r.writeConstraint ?? []).map((c) => c.expression).join('\n');
          expect(exprs, `${role} ${r.resourceType}`).toContain('%before.where(');
        }
      }
    }
  });

  test('only provider and integration may write clinical note types', () => {
    for (const [role, p] of Object.entries(policies)) {
      const clinicalWrites = (p.resource ?? []).filter(
        (r: AccessPolicyResource) => isLockable(r.resourceType) && r.interaction?.includes('update')
      );
      if (role === 'provider' || role === 'integration') {
        expect(clinicalWrites.length).toBeGreaterThan(0);
      } else {
        expect(clinicalWrites, role).toHaveLength(0);
      }
    }
  });

  test('ai_service writes only whitelisted workflow types', () => {
    const writes = (policies.ai_service.resource ?? [])
      .filter((r) => r.interaction?.includes('create') || r.interaction?.includes('update'))
      .map((r) => r.resourceType)
      .sort();
    expect(writes).toEqual(['Claim', 'Communication', 'DetectedIssue', 'Task']);
  });
});

describe('lock constraints (FHIRPath semantics)', () => {
  test('Encounter: drafts editable, finished / signature-bearing / labelled are locked', () => {
    expect(writable(integ, undefined, enc())).toBe(true);
    expect(writable(integ, enc(), enc({ status: 'finished' }))).toBe(true); // signing transition
    expect(writable(integ, enc({ status: 'finished' }), enc({ status: 'in-progress' }))).toBe(false);
    expect(writable(integ, enc({ status: 'finished' }), enc({ status: 'finished', period: { start: '2026' } }))).toBe(
      false
    );
    const sig = { extension: [{ url: ENCOUNTER_SIGNATURE_EXT, extension: [] }] };
    expect(writable(integ, enc(sig), enc())).toBe(false);
    expect(writable(integ, withLockLabel(enc()), enc())).toBe(false);
  });

  test('Encounter: cannot be created finished or signed', () => {
    expect(writable(integ, undefined, enc({ status: 'finished' }))).toBe(false);
    expect(writable(integ, undefined, enc({ extension: [{ url: ENCOUNTER_SIGNATURE_EXT }] }))).toBe(false);
  });

  test('subject cannot change', () => {
    expect(writable(integ, enc(), enc({ subject: { reference: 'Patient/other' } }))).toBe(false);
  });

  test('DocumentReference: final is immutable; final needs author+date; only appends relation', () => {
    const doc = (x: object = {}): any => ({
      resourceType: 'DocumentReference',
      id: 'd1',
      status: 'current',
      subject: { reference: 'Patient/p1' },
      content: [{ attachment: { contentType: 'text/plain' } }],
      ...x,
    });
    const final = { docStatus: 'final', author: [{ reference: 'Practitioner/x' }], date: '2026-09-01' };
    expect(writable(integ, undefined, doc(final))).toBe(true);
    expect(writable(integ, doc(final), doc({ ...final, description: 'x' }))).toBe(false);
    expect(writable(integ, doc(final), doc({ ...final, docStatus: 'preliminary' }))).toBe(false);
    expect(
      writable(integ, doc({ docStatus: 'preliminary' }), doc({ docStatus: 'preliminary', description: 'y' }))
    ).toBe(true);
    expect(writable(integ, undefined, doc({ docStatus: 'final', date: '2026-09-01' }))).toBe(false);
    expect(writable(integ, undefined, doc({ ...final, relatesTo: [{ code: 'appends', target: {} }] }))).toBe(true);
    expect(writable(integ, undefined, doc({ ...final, relatesTo: [{ code: 'replaces', target: {} }] }))).toBe(false);
  });

  test('QuestionnaireResponse locked once completed/amended', () => {
    const qr = (status: string): any => ({
      resourceType: 'QuestionnaireResponse',
      id: 'q',
      status,
      subject: { reference: 'Patient/p1' },
    });
    expect(writable(integ, qr('in-progress'), qr('completed'))).toBe(true);
    expect(writable(integ, qr('completed'), qr('in-progress'))).toBe(false);
    expect(writable(integ, qr('amended'), qr('amended'))).toBe(false);
  });

  test('Condition/Procedure locked only by the security label; label cannot be removed', () => {
    const proc = (x: object = {}): any => ({
      resourceType: 'Procedure',
      id: 'pr',
      status: 'completed',
      subject: { reference: 'Patient/p1' },
      ...x,
    });
    expect(writable(integ, proc(), proc({ note: [{ text: 'x' }] }))).toBe(true);
    expect(writable(integ, proc(), withLockLabel(proc()))).toBe(true); // applying the label at signing
    expect(writable(integ, withLockLabel(proc()), proc())).toBe(false); // removing it
    expect(writable(integ, withLockLabel(proc()), withLockLabel(proc({ note: [{ text: 'x' }] })))).toBe(false);
  });

  test('provider may only write own encounters (criteria)', () => {
    const provider = JSON.parse(
      JSON.stringify(policies.provider).replaceAll('%profile', 'Practitioner/me')
    ) as AccessPolicy;
    const mine = enc({ participant: [{ individual: { reference: 'Practitioner/me' } }] });
    const theirs = enc({ participant: [{ individual: { reference: 'Practitioner/other' } }] });
    expect(writable(provider, undefined, mine)).toBe(true);
    expect(writable(provider, undefined, theirs)).toBe(false);
  });

  test('ai_service Claim: drafts only', () => {
    const c = (status: string): any => ({ resourceType: 'Claim', id: 'c', status });
    expect(writable(policies.ai_service, undefined, c('draft'))).toBe(true);
    expect(writable(policies.ai_service, undefined, c('active'))).toBe(false);
    expect(writable(policies.ai_service, c('draft'), c('active'))).toBe(false);
    expect(writable(policies.ai_service, c('active'), c('draft'))).toBe(false);
  });
});

describe('buildSignLockEntries', () => {
  test('PUTs each lockable child with the label and If-Match', () => {
    const entries = buildSignLockEntries([
      { resourceType: 'Procedure', id: 'p1', status: 'completed', subject: {}, meta: { versionId: 'v1' } } as any,
      { resourceType: 'Patient', id: 'x' },
      { resourceType: 'Condition', subject: {} } as any, // no id: skipped
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].request).toEqual({ method: 'PUT', url: 'Procedure/p1', ifMatch: 'W/"v1"' });
    expect(entries[0].resource?.meta?.security).toContainEqual(SIGNED_LOCK_SECURITY);
    expect(LOCKABLE_RESOURCE_TYPES).toContain('Procedure');
  });
});

// Added by the adversarial review: rules that close write paths found against the live server.
describe('hardening (adversarial review)', () => {
  const doc = (x: object = {}): any => ({
    resourceType: 'DocumentReference',
    id: 'd1',
    status: 'current',
    subject: { reference: 'Patient/p1' },
    content: [{ attachment: { contentType: 'text/plain' } }],
    ...x,
  });
  const proc = (x: object = {}): any => ({
    resourceType: 'Procedure',
    id: 'pr',
    status: 'completed',
    subject: { reference: 'Patient/p1' },
    encounter: { reference: 'Encounter/draft' },
    ...x,
  });

  test('isResourceWriteable uses the FIRST entry matching the NEW version: no second writable entry may drop the lock', () => {
    // Medplum picks the entry for the write constraints by matching %after, not %before. If a policy had two
    // update-capable entries for one type and only one carried the lock, a write shaped to match the other
    // entry would skip the lock. Every update-capable entry of a lockable type must carry the full lock.
    for (const [role, policy] of Object.entries(policies)) {
      for (const entry of policy.resource ?? []) {
        const writes = !entry.interaction || entry.interaction.includes('update') || entry.interaction.includes('create');
        if (isLockable(entry.resourceType) && writes) {
          const exprs = (entry.writeConstraint ?? []).map((c) => c.expression);
          expect(exprs.some((e) => e?.includes('%before.where(')), `${role} ${entry.resourceType}`).toBe(true);
          expect(exprs.some((e) => e?.includes('subject.reference')), `${role} ${entry.resourceType}`).toBe(true);
        }
      }
    }
  });

  test('an addendum must be born final (a preliminary document that appends is refused)', () => {
    const rel = { relatesTo: [{ code: 'appends', target: { reference: 'DocumentReference/signed' } }] };
    const final = { docStatus: 'final', author: [{ reference: 'Practitioner/x' }], date: '2026-09-01' };
    expect(writable(integ, undefined, doc({ ...rel, docStatus: 'preliminary' }))).toBe(false);
    expect(writable(integ, undefined, doc({ ...rel }))).toBe(false); // docStatus absent
    expect(writable(integ, undefined, doc({ ...rel, ...final }))).toBe(true);
    // adding a relation to an existing preliminary document is refused as well
    expect(writable(integ, doc({ docStatus: 'preliminary' }), doc({ docStatus: 'preliminary', ...rel }))).toBe(false);
  });

  test("docStatus 'amended' counts as signed", () => {
    const amended = { docStatus: 'amended', author: [{ reference: 'Practitioner/x' }], date: '2026-09-01' };
    expect(writable(integ, doc(amended), doc({ ...amended, description: 'changed' }))).toBe(false);
  });

  test('a child record cannot be re-linked to another encounter (e.g. moved into a signed one)', () => {
    expect(writable(integ, proc(), proc({ note: [{ text: 'ok' }] }))).toBe(true);
    expect(writable(integ, proc(), proc({ encounter: { reference: 'Encounter/signed' } }))).toBe(false);
    expect(writable(integ, proc(), proc({ encounter: undefined }))).toBe(false);
    expect(writable(integ, proc({ encounter: undefined }), proc({ encounter: { reference: 'Encounter/signed' } }))).toBe(false);
    expect(writable(integ, proc({ encounter: undefined }), proc({ encounter: undefined, note: [{ text: 'x' }] }))).toBe(true);
    const d = doc({ docStatus: 'preliminary', context: { encounter: [{ reference: 'Encounter/draft' }] } });
    expect(writable(integ, d, { ...d, description: 'edit' })).toBe(true);
    expect(writable(integ, d, { ...d, context: { encounter: [{ reference: 'Encounter/signed' }] } })).toBe(false);
    expect(
      writable(integ, d, { ...d, context: { encounter: [{ reference: 'Encounter/draft' }, { reference: 'Encounter/signed' }] } })
    ).toBe(false);
    const qr = { resourceType: 'QuestionnaireResponse', id: 'q', status: 'in-progress', subject: { reference: 'Patient/p1' }, encounter: { reference: 'Encounter/draft' } } as any;
    expect(writable(integ, qr, { ...qr, encounter: { reference: 'Encounter/signed' } })).toBe(false);
  });
});
