/**
 * Live provisioning tests against a REAL Medplum server (skipped unless MEDPLUM_BASE_URL is set):
 *
 *   MEDPLUM_BASE_URL=http://localhost:8103/ npx vitest run test/provisioning test/content   (from packages/practiceai)
 *
 * Provisions two synthetic practices (fresh random organization UUIDs per run), then acts as each
 * practice's billing integration client exactly like the billing app's MedplumFhirGateway does
 * (client-credentials login, CRUD, transaction bundles with urn:uuid refs, If-Match updates, the
 * sign transaction, addendum, Claim/ClaimResponse).
 */
import type { MedplumClient } from '@medplum/core';
import type {
  Bundle,
  Claim,
  ClaimResponse,
  Condition,
  Coverage,
  DocumentReference,
  Encounter,
  Organization,
  Patient,
  Practitioner,
  Procedure,
  QuestionnaireResponse,
} from '@medplum/fhirtypes';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PT_SOAP_QUESTIONNAIRE, SYSTEMS } from '../../src/content';
import { npiWithCheckDigit, provisionPractice, toMedplumProjects } from '../../src/provisioning';
import type { MedplumProjectEnv, ProvisionPracticeInput, ProvisionResult } from '../../src/provisioning';
import { LIVE, clientLogin, statusOf, superAdminClient } from './live-helpers';

const SD = 'https://practiceai.example/fhir/StructureDefinition';
const SID = 'https://practiceai.example/fhir/sid';
const RUN = randomUUID().slice(0, 8);

function practice(label: string, npiPrefix: string): ProvisionPracticeInput {
  return {
    practiceName: `PracticeAI live test ${label} ${RUN}`,
    organizationId: randomUUID(),
    adminEmail: `admin-${label.toLowerCase()}-${RUN}@synthetic-pt.example`,
    providers: [
      { npi: npiWithCheckDigit(npiPrefix), firstName: 'Pat', lastName: `Synthetic${label}`, email: `pat-${label.toLowerCase()}-${RUN}@synthetic-pt.example`, suffix: 'DPT' },
    ],
  };
}

function entryOf(p: ProvisionResult, reveal: boolean): MedplumProjectEnv {
  const e = toMedplumProjects(p, { revealSecret: reveal })[p.organizationId];
  if (!e) throw new Error('no entry');
  return e;
}

describe.skipIf(!LIVE)('provisioning (live server)', () => {
  const inputA = practice('A', String(100000000 + Math.floor(Math.random() * 8e8)));
  const inputB = practice('B', String(100000000 + Math.floor(Math.random() * 8e8)));
  let admin: MedplumClient;
  let a1: ProvisionResult;
  let a2: ProvisionResult;
  let b: ProvisionResult;
  let clientA: MedplumClient;
  let clientB: MedplumClient;
  let providerA: Practitioner;

  beforeAll(async () => {
    admin = await superAdminClient();
    a1 = await provisionPractice(admin, inputA);
    a2 = await provisionPractice(admin, inputA);
    b = await provisionPractice(admin, inputB);
    const eA = entryOf(a1, true);
    const eB = entryOf(b, true);
    clientA = await clientLogin(eA.clientId, eA.clientSecret);
    clientB = await clientLogin(eB.clientId, eB.clientSecret);
    providerA = await clientA.readResource('Practitioner', a1.providers[0]?.practitionerId as string);
  }, 180_000);

  afterAll(() => {
    // Synthetic projects are left in the dev database for inspection (deprovisioning is out of scope).
  });

  test('re-provisioning is idempotent: same ids, nothing written, no new secret', () => {
    expect(a1.projectId).toBeTruthy();
    expect(a2.projectId).toBe(a1.projectId);
    expect(a2.practiceOrganizationId).toBe(a1.practiceOrganizationId);
    expect(a2.accessPolicies).toEqual(a1.accessPolicies);
    expect(a2.integration.clientId).toBe(a1.integration.clientId);
    expect(a2.aiService).toEqual(a1.aiService);
    expect(a2.admin).toEqual(a1.admin);
    expect(a2.providers).toEqual(a1.providers);
    expect(a2.content).toEqual(a1.content);
    expect(a2.actions.filter((x) => x.status !== 'unchanged')).toEqual([]);
    expect(a1.integration.clientSecret).not.toBeNull();
    expect(a2.integration.clientSecret).toBeNull();
    expect(b.projectId).not.toBe(a1.projectId);
  });

  test('output is a valid MEDPLUM_PROJECTS entry and the credentials land in the configured project', () => {
    const e = entryOf(a1, true);
    expect(e.projectId).toBe(a1.projectId);
    expect(e.baseUrl).toBe(admin.getBaseUrl());
    // MedplumProjectRepository.ready() compares this with `Project/${projectId}`.
    expect(clientA.getActiveLogin()?.project.reference).toBe(`Project/${a1.projectId}`);
    expect(clientB.getActiveLogin()?.project.reference).toBe(`Project/${b.projectId}`);
  });

  test('provisioned resources live in the practice project', async () => {
    const org = await admin.readResource('Organization', a1.practiceOrganizationId as string);
    expect(org.meta?.project).toBe(a1.projectId);
    expect(org.identifier).toContainEqual({ system: `${SID}/organization-id`, value: inputA.organizationId });
    expect(providerA.identifier).toContainEqual({ system: SYSTEMS.npi, value: inputA.providers?.[0]?.npi });
    const memberships = await admin.searchResources('ProjectMembership', { project: `Project/${a1.projectId}` }, { cache: 'no-cache' });
    const byProfile = new Map(memberships.map((m) => [m.profile?.reference, m]));
    expect(byProfile.get(`Practitioner/${a1.admin.practitionerId}`)?.accessPolicy?.reference).toBe(`AccessPolicy/${a1.accessPolicies.practice_admin}`);
    expect(byProfile.get(`Practitioner/${a1.admin.practitionerId}`)?.admin).not.toBe(true);
    expect(byProfile.get(`Practitioner/${a1.providers[0]?.practitionerId}`)?.accessPolicy?.reference).toBe(`AccessPolicy/${a1.accessPolicies.provider}`);
    expect(byProfile.get(`ClientApplication/${a1.integration.clientId}`)?.accessPolicy?.reference).toBe(`AccessPolicy/${a1.accessPolicies.integration}`);
    expect(byProfile.get(`ClientApplication/${a1.aiService.clientId}`)?.accessPolicy?.reference).toBe(`AccessPolicy/${a1.accessPolicies.ai_service}`);
  });

  describe('billing gateway operations with the integration client', () => {
    let patient: Patient;
    let coverage: Coverage;
    let encounter: Encounter;
    let condition: Condition;
    let procedure: Procedure;
    let qr: QuestionnaireResponse;

    beforeAll(async () => {
      const payer = await clientA.createResource<Organization>({ resourceType: 'Organization', name: `Synthetic Payer ${RUN}`, active: true });
      patient = await clientA.createResource<Patient>({
        resourceType: 'Patient',
        name: [{ given: ['Synthetic'], family: `Gateway${RUN}` }],
        birthDate: '1980-01-01',
        identifier: [{ system: `${SID}/mrn`, value: `MRN-${RUN}` }],
      });
      coverage = await clientA.createResource<Coverage>({
        resourceType: 'Coverage',
        status: 'active',
        beneficiary: { reference: `Patient/${patient.id}` },
        payor: [{ reference: `Organization/${payer.id}` }],
        subscriberId: `SYN${RUN}`,
      });
      // saveNote(): one transaction with urn:uuid cross references (pt-note.ts ptNoteToFhir).
      const encUrn = `urn:uuid:${randomUUID()}`;
      const dxUrn = `urn:uuid:${randomUUID()}`;
      const tx: Bundle = {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          {
            fullUrl: encUrn,
            request: { method: 'POST', url: 'Encounter' },
            resource: {
              resourceType: 'Encounter',
              status: 'in-progress',
              class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
              subject: { reference: `Patient/${patient.id}` },
              type: [{ coding: [{ system: SYSTEMS.ptVisitType, code: 'daily', display: 'PT daily treatment note' }] }],
              participant: [{ individual: { reference: `Practitioner/${providerA.id}` } }],
              period: { start: '2026-09-28T09:00:00-05:00' },
              serviceProvider: { reference: `Organization/${a1.practiceOrganizationId}` },
              extension: [
                { url: `${SD}/place-of-service`, valueCoding: { system: SYSTEMS.placeOfService, code: '11' } },
                { url: `${SD}/encounter-coverage`, valueReference: { reference: `Coverage/${coverage.id}` } },
                { url: `${SD}/prior-authorization`, extension: [{ url: 'number', valueString: `AUTH-${RUN}` }] },
                { url: `${SD}/visit-number`, valueInteger: 3 },
              ],
              diagnosis: [{ condition: { reference: dxUrn }, rank: 1 }],
            } satisfies Encounter,
          },
          {
            fullUrl: dxUrn,
            request: { method: 'POST', url: 'Condition' },
            resource: {
              resourceType: 'Condition',
              identifier: [{ system: `${SID}/note-line`, value: 'dx-1' }],
              code: { coding: [{ system: SYSTEMS.icd10cm, code: 'M54.50', display: 'Low back pain, unspecified' }] },
              subject: { reference: `Patient/${patient.id}` },
              encounter: { reference: encUrn },
            } satisfies Condition,
          },
          {
            request: { method: 'POST', url: 'Procedure' },
            resource: {
              resourceType: 'Procedure',
              identifier: [{ system: `${SID}/note-line`, value: 'proc-1' }],
              status: 'completed',
              extension: [
                { url: `${SD}/procedure-timed`, valueBoolean: true },
                { url: `${SD}/procedure-minutes`, valueInteger: 23 },
                { url: `${SD}/procedure-modifier`, valueCoding: { system: SYSTEMS.cptModifier, code: 'GP' } },
              ],
              code: { coding: [{ system: SYSTEMS.cpt, code: '97110', display: 'Therapeutic exercise, each 15 min' }] },
              subject: { reference: `Patient/${patient.id}` },
              encounter: { reference: encUrn },
              performer: [{ actor: { reference: `Practitioner/${providerA.id}` } }],
              reasonReference: [{ reference: dxUrn }],
            } satisfies Procedure,
          },
          {
            request: { method: 'POST', url: 'QuestionnaireResponse' },
            resource: {
              resourceType: 'QuestionnaireResponse',
              identifier: { system: `${SID}/note-line`, value: 'soap' },
              questionnaire: PT_SOAP_QUESTIONNAIRE,
              status: 'in-progress',
              subject: { reference: `Patient/${patient.id}` },
              encounter: { reference: encUrn },
              author: { reference: `Practitioner/${providerA.id}` },
              item: ['subjective', 'objective', 'assessment', 'plan'].map((linkId) => ({ linkId, answer: [{ valueString: `Synthetic ${linkId}` }] })),
            } satisfies QuestionnaireResponse,
          },
        ],
      };
      const res = await clientA.executeBatch(tx);
      const statuses = (res.entry ?? []).map((e) => e.response?.status ?? '');
      expect(statuses.every((s) => s.startsWith('201'))).toBe(true);
      encounter = res.entry?.[0]?.resource as Encounter;
      condition = res.entry?.[1]?.resource as Condition;
      procedure = res.entry?.[2]?.resource as Procedure;
      qr = res.entry?.[3]?.resource as QuestionnaireResponse;
      expect(condition.encounter?.reference).toBe(`Encounter/${encounter.id}`);
    }, 120_000);

    test('reads and searches what the gateway reads', async () => {
      await expect(clientA.readResource('Patient', patient.id as string)).resolves.toMatchObject({ id: patient.id });
      await expect(clientA.readResource('Practitioner', providerA.id as string)).resolves.toMatchObject({ id: providerA.id });
      await expect(clientA.readResource('Organization', a1.practiceOrganizationId as string)).resolves.toBeTruthy();
      const encRef = `Encounter/${encounter.id}`;
      expect((await clientA.searchResources('Condition', { encounter: encRef })).map((c) => c.id)).toEqual([condition.id]);
      expect((await clientA.searchResources('Procedure', { encounter: encRef })).map((c) => c.id)).toEqual([procedure.id]);
      expect((await clientA.searchResources('QuestionnaireResponse', { encounter: encRef })).map((c) => c.id)).toEqual([qr.id]);
      expect((await clientA.searchResources('Coverage', { beneficiary: `Patient/${patient.id}` })).map((c) => c.id)).toEqual([coverage.id]);
      expect((await clientA.searchResources('Practitioner', { identifier: `${SYSTEMS.npi}|${providerA.identifier?.[0]?.value}` })).map((p) => p.id)).toEqual([
        providerA.id,
      ]);
      const history = await clientA.readHistory('Encounter', encounter.id as string);
      expect(history.entry?.length).toBeGreaterThanOrEqual(1);
    });

    test('draft autosave with If-Match; stale version is rejected', async () => {
      const updated = await clientA.updateResource<Encounter>(
        { ...encounter, period: { ...encounter.period, end: '2026-09-28T09:50:00-05:00' } },
        { headers: { 'If-Match': `W/"${encounter.meta?.versionId}"` } },
      );
      expect(updated.meta?.versionId).not.toBe(encounter.meta?.versionId);
      const stale = await statusOf(
        clientA.updateResource<Encounter>({ ...encounter, period: { start: '2026-09-28T08:00:00-05:00' } }, { headers: { 'If-Match': `W/"${encounter.meta?.versionId}"` } }),
      );
      expect(stale).not.toBe(0);
      encounter = updated;
    });

    test('sign transaction, then addendum as a separate DocumentReference; signed note stays unchanged', async () => {
      const signedAt = '2026-09-28T15:00:00.000Z';
      const noteUrn = `urn:uuid:${randomUUID()}`;
      const signTx: Bundle = {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          {
            request: { method: 'PUT', url: `Encounter/${encounter.id}`, ifMatch: `W/"${encounter.meta?.versionId}"` },
            resource: {
              ...encounter,
              status: 'finished',
              extension: [
                ...(encounter.extension ?? []),
                {
                  url: `${SD}/encounter-signature`,
                  extension: [
                    { url: 'signedAt', valueDateTime: signedAt },
                    { url: 'signedBy', valueReference: { reference: `Practitioner/${providerA.id}` } },
                    { url: 'contentHash', valueString: 'a'.repeat(64) },
                    { url: 'noteDocument', valueReference: { reference: noteUrn } },
                  ],
                },
              ],
            },
          },
          { request: { method: 'PUT', url: `QuestionnaireResponse/${qr.id}` }, resource: { ...qr, status: 'completed', authored: signedAt } },
          {
            fullUrl: noteUrn,
            request: { method: 'POST', url: 'DocumentReference' },
            resource: {
              resourceType: 'DocumentReference',
              extension: [{ url: `${SD}/content-sha256`, valueString: 'a'.repeat(64) }],
              status: 'current',
              docStatus: 'final',
              type: { coding: [{ system: 'http://loinc.org', code: '11506-3', display: 'Progress note' }] },
              subject: { reference: `Patient/${patient.id}` },
              date: signedAt,
              author: [{ reference: `Practitioner/${providerA.id}` }],
              authenticator: { reference: `Practitioner/${providerA.id}` },
              content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Synthetic signed note').toString('base64') } }],
              context: { encounter: [{ reference: `Encounter/${encounter.id}` }] },
            } satisfies DocumentReference,
          },
        ],
      };
      const signed = await clientA.executeBatch(signTx);
      expect((signed.entry ?? []).map((e) => e.response?.status?.slice(0, 3))).toEqual(['200', '200', '201']);
      const noteDoc = signed.entry?.[2]?.resource as DocumentReference;
      const signedEnc = signed.entry?.[0]?.resource as Encounter;
      expect(signedEnc.extension?.find((e) => e.url === `${SD}/encounter-signature`)?.extension?.find((e) => e.url === 'noteDocument')?.valueReference?.reference).toBe(
        `DocumentReference/${noteDoc.id}`,
      );

      // ENC-02: the signed encounter and signed note cannot be silently edited (server-side lock from the policies module).
      expect(await statusOf(clientA.updateResource<Encounter>({ ...signedEnc, period: { start: '2026-09-27T09:00:00-05:00' } }))).toBe(403);
      expect(await statusOf(clientA.updateResource<DocumentReference>({ ...noteDoc, description: 'silently edited' }))).toBe(403);

      // AI-03: addendum is a new, separately authored and timestamped DocumentReference that appends the note.
      const addendum = await clientA.createResource<DocumentReference>({
        resourceType: 'DocumentReference',
        extension: [
          { url: `${SD}/content-sha256`, valueString: 'b'.repeat(64) },
          { url: `${SD}/addendum-approved-by`, valueString: 'synthetic-user' },
        ],
        status: 'current',
        docStatus: 'final',
        type: { coding: [{ system: 'http://loinc.org', code: '55107-7', display: 'Addendum Document' }] },
        subject: { reference: `Patient/${patient.id}` },
        date: '2026-09-29T10:00:00.000Z',
        author: [{ reference: `Practitioner/${providerA.id}` }],
        description: 'Addendum to signed PT note',
        relatesTo: [{ code: 'appends', target: { reference: `DocumentReference/${noteDoc.id}` } }],
        content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Synthetic addendum').toString('base64') } }],
        context: { encounter: [{ reference: `Encounter/${encounter.id}` }] },
      });
      expect(addendum.id).toBeTruthy();
      const related = await clientA.searchResources('DocumentReference', { encounter: `Encounter/${encounter.id}` });
      expect(related.map((d) => d.id).sort()).toEqual([noteDoc.id, addendum.id].sort());
      const noteNow = await clientA.readResource('DocumentReference', noteDoc.id as string);
      expect(noteNow.meta?.versionId).toBe(noteDoc.meta?.versionId);

      // Server guard (Project.systemSetting practiceai-signed-lock, set by provisioning): the encounter's
      // Procedure/Condition (not labelled by this sign transaction) are locked, and nothing new can be attached.
      expect(await statusOf(clientA.updateResource<Procedure>({ ...procedure, status: 'entered-in-error' }))).toBe(403);
      expect(await statusOf(clientA.updateResource<Condition>({ ...condition, recordedDate: '2026-09-29' }))).toBe(403);
      expect(
        await statusOf(
          clientA.createResource<Procedure>({
            resourceType: 'Procedure',
            status: 'completed',
            code: { coding: [{ system: SYSTEMS.cpt, code: '97140' }] },
            subject: { reference: `Patient/${patient.id}` },
            encounter: { reference: `Encounter/${encounter.id}` },
          }),
        ),
      ).toBe(403);
    });

    test('Claim and ClaimResponse create/update', async () => {
      const claimVersionId = randomUUID();
      const claim = await clientA.createResource<Claim>({
        resourceType: 'Claim',
        identifier: [{ system: `${SID}/claim-version`, value: claimVersionId }],
        status: 'active',
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
        use: 'claim',
        patient: { reference: `Patient/${patient.id}` },
        created: '2026-09-29T10:00:00.000Z',
        provider: { reference: `Organization/${a1.practiceOrganizationId}` },
        priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/processpriority', code: 'normal' }] },
        insurance: [{ sequence: 1, focal: true, coverage: { reference: `Coverage/${coverage.id}` } }],
        item: [{ sequence: 1, productOrService: { coding: [{ system: SYSTEMS.cpt, code: '97110' }] }, quantity: { value: 2 } }],
      });
      const found = await clientA.searchResources('Claim', { identifier: `${SID}/claim-version|${claimVersionId}` });
      expect(found.map((c) => c.id)).toEqual([claim.id]);
      const claim2 = await clientA.updateResource<Claim>({ ...claim, status: 'cancelled' }, { headers: { 'If-Match': `W/"${claim.meta?.versionId}"` } });
      expect(claim2.status).toBe('cancelled');

      const response = await clientA.createResource<ClaimResponse>({
        resourceType: 'ClaimResponse',
        status: 'active',
        type: claim.type,
        use: 'claim',
        patient: claim.patient,
        created: '2026-09-30T10:00:00.000Z',
        insurer: { display: 'Synthetic Payer' },
        request: { reference: `Claim/${claim.id}` },
        outcome: 'complete',
      });
      expect((await clientA.searchResources('ClaimResponse', { request: `Claim/${claim.id}` })).map((r) => r.id)).toEqual([response.id]);
      const response2 = await clientA.updateResource<ClaimResponse>({ ...response, disposition: 'Paid (synthetic)' });
      expect(response2.disposition).toBe('Paid (synthetic)');
    });

    test('project isolation: practice B cannot see practice A, and vice versa', async () => {
      expect(await statusOf(clientB.readResource('Patient', patient.id as string))).toBe(404);
      expect(await statusOf(clientB.readResource('Encounter', encounter.id as string))).toBe(404);
      expect(await statusOf(clientB.readResource('Organization', a1.practiceOrganizationId as string))).toBe(404);
      expect(await statusOf(clientB.readResource('Practitioner', providerA.id as string))).toBe(404);
      expect((await clientB.searchResources('Patient', { _id: patient.id as string })).length).toBe(0);
      expect((await clientB.searchResources('Encounter', { patient: `Patient/${patient.id}` })).length).toBe(0);

      const patientB = await clientB.createResource<Patient>({ resourceType: 'Patient', name: [{ given: ['Synthetic'], family: `OtherPractice${RUN}` }] });
      expect(await statusOf(clientA.readResource('Patient', patientB.id as string))).toBe(404);
      expect(await statusOf(clientA.updateResource<Patient>({ ...patientB, gender: 'unknown' }))).not.toBe(0);

      // A client cannot write into another project by setting meta.project.
      const sneaky = await clientA
        .createResource<Patient>({ resourceType: 'Patient', meta: { project: b.projectId as string }, name: [{ family: `Sneaky${RUN}` }] })
        .catch(() => null);
      if (sneaky) {
        expect(sneaky.meta?.project).toBe(a1.projectId);
        expect(await statusOf(clientB.readResource('Patient', sneaky.id as string))).toBe(404);
      }

      // Every Patient visible to A is in project A.
      for (const p of await clientA.searchResources('Patient', { _count: '100' })) expect(p.meta?.project).toBe(a1.projectId);
    });
  });
});
