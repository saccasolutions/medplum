// Per-role allowed / denied operations against the REAL server (plan §6.1).

import type { Claim, Encounter } from '@medplum/fhirtypes';
import type { Fixture, NoteSet, SignedNote } from './fixture';
import { addendum, draftEncounter, setupFixture, signNote, writeDraftNote } from './fixture';
import { LIVE, expectAllowed, expectForbidden, expectStatus } from './harness';

function claim(patientId: string, coverageId: string, status: Claim['status'] = 'draft'): Claim {
  return {
    resourceType: 'Claim',
    status,
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
    use: 'claim',
    patient: { reference: `Patient/${patientId}` },
    created: '2026-09-02',
    provider: { display: 'Synthetic Practice' },
    priority: { coding: [{ code: 'normal' }] },
    insurance: [{ sequence: 1, focal: true, coverage: { reference: `Coverage/${coverageId}` } }],
  };
}

describe.skipIf(!LIVE)('Role access policies (live server)', () => {
  let fx: Fixture;
  let draft: NoteSet;
  let signed: SignedNote;
  let pRef: string;
  let patientId: string;
  let coverageId: string;

  beforeAll(async () => {
    fx = await setupFixture();
    const { integration } = fx.a.actors;
    pRef = fx.a.practitioner.reference as string;
    patientId = fx.a.patient.id;
    coverageId = fx.a.coverage.id;
    draft = await writeDraftNote(integration, `Patient/${patientId}`, pRef);
    signed = await signNote(integration, await writeDraftNote(integration, `Patient/${patientId}`, pRef), pRef, {
      lockChildren: true,
    });
  }, 180_000);

  test('policies are installed in the practice project and memberships are not project admins', async () => {
    const { superAdmin, a } = fx;
    const list = await superAdmin.get(`AccessPolicy?_project=${a.projectId}&_count=50`);
    expectStatus(list, 200, 'list policies');
    expect(list.body.entry.map((e: any) => e.resource.name).sort()).toEqual(
      Object.values(a.policies)
        .map((p) => p.name)
        .sort()
    );
    for (const m of Object.values(a.memberships)) {
      expect(m?.admin).toBeFalsy();
      expect(m?.accessPolicy?.reference).toMatch(/^AccessPolicy\//);
    }
  });

  describe('provider', () => {
    test('documents and signs own encounter; reads chart', async () => {
      const { provider } = fx.a.actors;
      const own = await writeDraftNote(provider, `Patient/${patientId}`, pRef);
      const s = await signNote(provider, own, pRef, { lockChildren: true });
      expect(s.encounter.status).toBe('finished');
      expectAllowed(await provider.get(`Encounter/${draft.encounter.id}`), 'read encounter');
      expectAllowed(await provider.get(`DocumentReference/${signed.noteDocument.id}`), 'read signed note');
      expectAllowed(await provider.get(`Coverage/${coverageId}`), 'read coverage');
      expectAllowed(await provider.create(addendum(signed, pRef)), 'author addendum');
    });

    test("cannot create, edit or take over another provider's encounter", async () => {
      const { provider, provider2 } = fx.a.actors;
      const p2 = fx.a.practitioner2.reference as string;
      expectForbidden(
        await provider.create<Encounter>(draftEncounter(`Patient/${patientId}`, p2)),
        'create encounter for other provider'
      );
      const theirs = await writeDraftNote(provider2, `Patient/${patientId}`, p2);
      expectForbidden(
        await provider.update<Encounter>({ ...theirs.encounter, period: { start: '2026-09-09T09:00:00Z' } }),
        'edit other provider encounter'
      );
      expectForbidden(
        await provider.update<Encounter>({ ...theirs.encounter, participant: draft.encounter.participant }),
        'reassign other provider encounter to self'
      );
      expectForbidden(
        await provider.update({ ...theirs.questionnaireResponse, author: { reference: pRef } }),
        'edit other QR'
      );
    });

    test('cannot write patient demographics, coverage or claims; cannot delete', async () => {
      const { provider } = fx.a.actors;
      expectForbidden(await provider.update({ ...fx.a.patient, birthDate: '1971-01-01' }), 'update Patient');
      expectForbidden(await provider.update({ ...fx.a.coverage, subscriberId: 'X' }), 'update Coverage');
      expectForbidden(await provider.create(claim(patientId, coverageId)), 'create Claim');
      expectForbidden(await provider.delete(`Encounter/${draft.encounter.id}`), 'delete draft Encounter');
      expectForbidden(await provider.create({ resourceType: 'AccessPolicy', name: 'x' }), 'create AccessPolicy');
    });
  });

  describe('front_office', () => {
    test('writes Patient, Coverage, Appointment', async () => {
      const { front_office: fo } = fx.a.actors;
      const p = await fo.create({
        resourceType: 'Patient',
        name: [{ family: 'Synthetic-FO' }],
        birthDate: '1990-02-02',
      });
      expectAllowed(p, 'create Patient');
      expectAllowed(await fo.update({ ...p.body, gender: 'unknown' }), 'update Patient');
      const c = await fo.create({
        resourceType: 'Coverage',
        status: 'active',
        beneficiary: { reference: `Patient/${p.body.id}` },
        payor: [{ display: 'Synthetic Payer' }],
      });
      expectAllowed(c, 'create Coverage');
      expectAllowed(await fo.update({ ...c.body, subscriberId: 'FO-1' }), 'update Coverage');
      expectForbidden(
        await fo.update({ ...c.body, beneficiary: { reference: `Patient/${patientId}` } }),
        'move Coverage to another patient'
      );
      expectAllowed(
        await fo.create({
          resourceType: 'Appointment',
          status: 'booked',
          participant: [{ actor: { reference: `Patient/${p.body.id}` }, status: 'accepted' }],
          start: '2026-10-01T09:00:00Z',
          end: '2026-10-01T09:45:00Z',
        }),
        'create Appointment'
      );
    });

    test('no clinical notes: reads visit list without diagnoses, nothing else', async () => {
      const { front_office: fo } = fx.a.actors;
      const enc = await fo.get(`Encounter/${signed.encounter.id}`);
      expectAllowed(enc, 'read Encounter');
      expect(enc.body.diagnosis).toBeUndefined();
      expect(enc.body.extension).toBeUndefined();
      for (const path of [
        `Condition/${signed.condition.id}`,
        `Procedure/${signed.procedure.id}`,
        `QuestionnaireResponse/${signed.questionnaireResponse.id}`,
        `DocumentReference/${signed.noteDocument.id}`,
        'DocumentReference?_count=1',
        'Claim?_count=1',
      ]) {
        expectForbidden(await fo.get(path), `read ${path}`);
      }
      expectForbidden(await fo.update({ ...draft.encounter, status: 'arrived' }), 'update Encounter');
      expectForbidden(await fo.create(addendum(signed, pRef)), 'create DocumentReference');
      expectForbidden(await fo.delete(`Patient/${patientId}`), 'delete Patient');
    });
  });

  describe('biller', () => {
    test('read-only clinical: cannot write any clinical resource, even unsigned drafts', async () => {
      const { biller } = fx.a.actors;
      expectAllowed(await biller.get(`Encounter/${draft.encounter.id}`), 'read Encounter');
      expectAllowed(await biller.get(`DocumentReference/${signed.noteDocument.id}`), 'read note');
      expectAllowed(await biller.get(`Procedure?encounter=Encounter/${signed.encounter.id}`), 'search Procedure');
      expectForbidden(
        await biller.update({ ...draft.encounter, period: { start: '2026-09-05T09:00:00Z' } }),
        'PUT draft Encounter'
      );
      expectForbidden(
        await biller.patch(`Procedure/${draft.procedure.id}`, [
          { op: 'replace', path: '/code/coding/0/code', value: '97530' },
        ]),
        'PATCH draft Procedure (upcode)'
      );
      expectForbidden(
        await biller.patch(`Condition/${draft.condition.id}`, [
          { op: 'replace', path: '/code/coding/0/code', value: 'M25.561' },
        ]),
        'PATCH draft Condition'
      );
      expectForbidden(await biller.create(addendum(signed, pRef)), 'create DocumentReference');
      expectForbidden(await biller.create<Encounter>(draftEncounter(`Patient/${patientId}`, pRef)), 'create Encounter');
      expectForbidden(await biller.update({ ...fx.a.patient, birthDate: '1972-01-01' }), 'update Patient');
    });

    test('writes Claim / ClaimResponse / Coverage admin fields; no deletes', async () => {
      const { biller } = fx.a.actors;
      const c = await biller.create(claim(patientId, coverageId));
      expectAllowed(c, 'create Claim');
      expectAllowed(await biller.update({ ...c.body, status: 'active' }), 'submit Claim');
      expectAllowed(
        await biller.create({
          resourceType: 'ClaimResponse',
          status: 'active',
          type: c.body.type,
          use: 'claim',
          patient: c.body.patient,
          created: '2026-09-20',
          insurer: { display: 'Synthetic Payer' },
          outcome: 'complete',
          request: { reference: `Claim/${c.body.id}` },
        }),
        'create ClaimResponse'
      );
      expectAllowed(
        await biller.update({ ...fx.a.coverage, subscriberId: `SUB-FIX-${fx.a.run}` }),
        'fix Coverage subscriber id'
      );
      // A real second patient: the project checks references on write, so a made-up id would be a 400.
      const other = await fx.a.actors.integration.create({
        resourceType: 'Patient',
        name: [{ given: ['Synthetic'], family: `Other-${fx.a.run}` }],
      });
      expectAllowed(other, 'second patient');
      expectForbidden(
        await biller.update({
          ...fx.a.coverage,
          beneficiary: { reference: `Patient/${other.body.id}` },
        }),
        'reassign Coverage beneficiary'
      );
      expectForbidden(await biller.delete(`Claim/${c.body.id}`), 'delete Claim');
    });
  });

  describe('rcm_supervisor', () => {
    test('biller rights + DetectedIssue disposition + audit read; no clinical writes', async () => {
      const { rcm_supervisor: sup } = fx.a.actors;
      expectAllowed(await sup.create(claim(patientId, coverageId)), 'create Claim');
      const di = await sup.create({
        resourceType: 'DetectedIssue',
        status: 'final',
        code: { text: 'Synthetic finding dispositioned' },
        implicated: [{ reference: `Encounter/${signed.encounter.id}` }],
      });
      expectAllowed(di, 'create DetectedIssue');
      expectAllowed(await sup.get('AuditEvent?_count=1'), 'search AuditEvent');
      expectForbidden(
        await sup.update({ ...draft.encounter, period: { start: '2026-09-06T09:00:00Z' } }),
        'PUT Encounter'
      );
      expectForbidden(await sup.create(addendum(signed, pRef)), 'create DocumentReference');
    });
  });

  describe('practice_admin', () => {
    test('manages practice directory; read-only chart; no clinical edits', async () => {
      const { practice_admin: pa } = fx.a.actors;
      const pr = await pa.create({ resourceType: 'Practitioner', name: [{ family: 'Synthetic-NewPT' }] });
      expectAllowed(pr, 'create Practitioner');
      expectAllowed(await pa.create({ resourceType: 'Location', name: 'Synthetic Clinic Room 2' }), 'create Location');
      expectAllowed(await pa.get(`DocumentReference/${signed.noteDocument.id}`), 'read note');
      expectForbidden(
        await pa.update({ ...draft.encounter, period: { start: '2026-09-07T09:00:00Z' } }),
        'PUT Encounter'
      );
      expectForbidden(await pa.create(addendum(signed, pRef)), 'create DocumentReference');
      expectForbidden(await pa.update({ ...fx.a.patient, birthDate: '1973-01-01' }), 'update Patient');
    });

    test('cannot escalate: no AccessPolicy/ClientApplication/ProjectMembership writes, no admin API', async () => {
      const { practice_admin: pa } = fx.a.actors;
      const policy = fx.a.policies.practice_admin;
      expectAllowed(await pa.get(`AccessPolicy/${policy.id}`), 'read own policy');
      expectForbidden(await pa.update({ ...policy, resource: [{ resourceType: '*' }] }), 'widen AccessPolicy');
      expectForbidden(
        await pa.create({ resourceType: 'AccessPolicy', name: 'x', resource: [{ resourceType: '*' }] }),
        'create AccessPolicy'
      );
      expectForbidden(await pa.create({ resourceType: 'ClientApplication', name: 'x' }), 'create ClientApplication');
      expectForbidden(await pa.get('ProjectMembership?_count=1'), 'search ProjectMembership');
      expectForbidden(
        await pa.request('POST', `admin/projects/${fx.a.projectId}/client`, { name: 'x' }),
        'admin API create client'
      );
      expectForbidden(
        await pa.request('POST', `admin/projects/${fx.a.projectId}/invite`, {
          resourceType: 'Practitioner',
          firstName: 'X',
          lastName: 'Y',
          email: `x-${fx.a.run}@synthetic.example.com`,
        }),
        'admin API invite'
      );
      const client = await pa.get(`ClientApplication?_count=5`);
      expectAllowed(client, 'list ClientApplications');
      for (const e of client.body.entry ?? []) {
        expect(e.resource.secret).toBeUndefined();
      }
    });
  });

  describe('ai_service', () => {
    test('reads permitted resources (minimum necessary Patient fields)', async () => {
      const { ai_service: ai } = fx.a.actors;
      expectAllowed(await ai.get(`Encounter/${signed.encounter.id}`), 'read Encounter');
      expectAllowed(await ai.get(`DocumentReference/${signed.noteDocument.id}`), 'read note');
      expectAllowed(await ai.get(`Procedure?encounter=Encounter/${signed.encounter.id}`), 'search Procedure');
      const p = await ai.get(`Patient/${patientId}`);
      expectAllowed(p, 'read Patient');
      expect(p.body.telecom).toBeUndefined();
      expectForbidden(await ai.get('RelatedPerson?_count=1'), 'read RelatedPerson');
      expectForbidden(await ai.get('AuditEvent?_count=1'), 'read AuditEvent');
      expectForbidden(await ai.get('AccessPolicy?_count=1'), 'read AccessPolicy');
    });

    test('writes only Claim drafts, Task, Communication, DetectedIssue', async () => {
      const { ai_service: ai } = fx.a.actors;
      const c = await ai.create(claim(patientId, coverageId, 'draft'));
      expectAllowed(c, 'create Claim draft');
      expectAllowed(await ai.update({ ...c.body, created: '2026-09-03' }), 'edit Claim draft');
      expectForbidden(await ai.update({ ...c.body, status: 'active' }), 'submit Claim');
      expectForbidden(await ai.create(claim(patientId, coverageId, 'active')), 'create active Claim');
      expectAllowed(
        await ai.create({
          resourceType: 'DetectedIssue',
          status: 'preliminary',
          code: { text: 'Synthetic: timed minutes do not support 3 units' },
          implicated: [{ reference: `Procedure/${signed.procedure.id}` }],
        }),
        'create DetectedIssue'
      );
      expectAllowed(
        await ai.create({
          resourceType: 'Task',
          status: 'requested',
          intent: 'proposal',
          focus: { reference: `Encounter/${signed.encounter.id}` },
          description: 'Synthetic: provider review suggested',
        }),
        'create Task'
      );
      expectAllowed(
        await ai.create({
          resourceType: 'Communication',
          status: 'completed',
          payload: [{ contentString: 'Synthetic' }],
        }),
        'create Communication'
      );
    });

    test('never writes clinical content (even unsigned), coverage, or patients', async () => {
      const { ai_service: ai } = fx.a.actors;
      expectForbidden(await ai.create<Encounter>(draftEncounter(`Patient/${patientId}`, pRef)), 'create Encounter');
      expectForbidden(
        await ai.update({ ...draft.encounter, period: { start: '2026-09-08T09:00:00Z' } }),
        'PUT draft Encounter'
      );
      expectForbidden(
        await ai.patch(`Procedure/${draft.procedure.id}`, [
          { op: 'replace', path: '/code/coding/0/code', value: '97530' },
        ]),
        'PATCH draft Procedure'
      );
      expectForbidden(await ai.update({ ...draft.condition, note: [{ text: 'AI edit' }] }), 'PUT draft Condition');
      expectForbidden(
        await ai.update({ ...draft.questionnaireResponse, item: [{ linkId: 'subjective', text: 'AI rewrite' }] }),
        'PUT draft QR'
      );
      expectForbidden(
        await ai.create(addendum(signed, pRef)),
        'create DocumentReference (addendum must be human-approved via app)'
      );
      expectForbidden(await ai.update({ ...fx.a.coverage, subscriberId: 'AI' }), 'update Coverage');
      expectForbidden(await ai.update({ ...fx.a.patient, birthDate: '1974-01-01' }), 'update Patient');
      const own = await ai.create(claim(patientId, coverageId, 'draft'));
      expectForbidden(await ai.delete(`Claim/${own.body.id}`), 'delete own Claim draft');
      expectForbidden(await ai.delete(`Encounter/${draft.encounter.id}`), 'delete Encounter');
    });
  });

  describe('integration client (billing platform)', () => {
    test('intake, notes, claims; no deletes; no admin resources', async () => {
      const { integration } = fx.a.actors;
      expectAllowed(await integration.create(claim(patientId, coverageId, 'active')), 'create Claim');
      expectAllowed(await integration.get(`Practitioner/${pRef.split('/')[1]}`), 'read Practitioner');
      expectForbidden(
        await integration.update({ resourceType: 'Practitioner', id: pRef.split('/')[1], name: [{ family: 'x' }] }),
        'update Practitioner'
      );
      expectForbidden(await integration.delete(`Patient/${patientId}`), 'delete Patient');
      expectForbidden(await integration.create({ resourceType: 'AccessPolicy', name: 'x' }), 'create AccessPolicy');
      expectForbidden(await integration.create({ resourceType: 'Bot', name: 'x' }), 'create Bot');
      expectForbidden(
        await integration.create({
          resourceType: 'Subscription',
          status: 'active',
          reason: 'x',
          criteria: 'Patient',
          channel: { type: 'rest-hook', endpoint: 'https://example.com' },
        }),
        'create Subscription'
      );
      expectForbidden(await integration.get('ProjectMembership?_count=1'), 'read ProjectMembership');
    });
  });
});
