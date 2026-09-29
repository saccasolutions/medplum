// Adversarial review of the signed-encounter lock and the role limits against the REAL server.
// Every write path a client can reach is tried against a signed note, by every role identity:
// PUT / conditional PUT / PATCH (JSON Patch on status, meta, extension, content) / batch / transaction
// PATCH entries / $-operations that write / DELETE incl. conditional / _history / GraphQL mutations /
// upsert-create at a chosen id / Binary overwrite. Afterwards the signed resources must be byte-identical.
//
// Run: MEDPLUM_BASE_URL=http://localhost:8103 npx vitest run --config test/policies/vitest.live.config.ts

import type { Encounter } from '@medplum/fhirtypes';
import { LOINC_PROGRESS_NOTE, LOINC_SYSTEM } from '../../src/policies';
import type { Fixture, SignedNote } from './fixture';
import { addendum, setupFixture, signNote, strip, writeDraftNote } from './fixture';
import type { Actor, HttpResult } from './harness';
import { BASE_URL, LIVE, describe_, expectAllowed, expectForbidden, expectStatus } from './harness';

function isSuccess(r: HttpResult): boolean {
  return r.status >= 200 && r.status < 300;
}

/** GraphQL answers 200 with `errors`; a mutation must come back with an error and no data. */
function expectGraphqlDenied(r: HttpResult, what: string): void {
  const errors = r.body?.errors as { message?: string }[] | undefined;
  if (!errors?.length) {
    throw new Error(`${what}: expected GraphQL errors, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const data = r.body?.data ? Object.values(r.body.data as Record<string, unknown>) : [];
  expect(data.every((v) => v === null), what).toBe(true);
}

async function rawBinaryPut(actor: Actor, id: string): Promise<HttpResult> {
  const res = await fetch(`${BASE_URL}fhir/R4/Binary/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${actor.client.getAccessToken()}`, 'Content-Type': 'text/plain' },
    body: 'tampered',
  });
  return { status: res.status, body: await res.text() };
}

function graphql(actor: Actor, query: string): Promise<HttpResult> {
  return actor.request('POST', `${BASE_URL}fhir/R4/$graphql`, { query }, 'application/json');
}

describe.skipIf(!LIVE)('Adversarial: signed-encounter lock and role limits (live server)', () => {
  let fx: Fixture;
  let signed: SignedNote;
  let patientRef: string;
  let pract: string;

  beforeAll(async () => {
    fx = await setupFixture();
    const { integration } = fx.a.actors;
    patientRef = `Patient/${fx.a.patient.id}`;
    pract = fx.a.practitioner.reference as string;
    signed = await signNote(integration, await writeDraftNote(integration, patientRef, pract), pract, {
      lockChildren: true,
    });
  }, 180_000);

  const everyRole = (): [string, Actor][] => Object.entries(fx.a.actors);

  test('every write path, every role: the signed Encounter / note / QR / labelled children cannot change', async () => {
    const encId = signed.encounter.id;
    const docId = signed.noteDocument.id;
    const reverted: Encounter = { ...signed.encounter, status: 'in-progress', extension: undefined };
    for (const [name, a] of everyRole()) {
      const denied = (r: HttpResult, what: string): void => {
        if (isSuccess(r)) {
          throw new Error(`${name} ${what}: expected a refusal, got ${describe_(r)}`);
        }
      };
      expectForbidden(await a.request('PUT', `Encounter?_id=${encId}`, reverted), `${name} conditional PUT`);
      const batch = await a.request('POST', '', {
        resourceType: 'Bundle',
        type: 'batch',
        entry: [{ request: { method: 'PUT', url: `Encounter/${encId}` }, resource: reverted }],
      });
      expectAllowed(batch, `${name} batch envelope`);
      expect(batch.body.entry[0].response.status, `${name} batch PUT entry`).toBe('403');
      const patchEntry = await a.transaction([
        {
          request: { method: 'PATCH', url: `Encounter/${encId}` },
          resource: {
            resourceType: 'Binary',
            contentType: 'application/json-patch+json',
            data: Buffer.from(JSON.stringify([{ op: 'replace', path: '/status', value: 'in-progress' }])).toString(
              'base64'
            ),
          },
        },
      ]);
      expectForbidden(patchEntry, `${name} transaction PATCH entry`);
      expectForbidden(
        await a.patch(`Encounter/${encId}`, [
          { op: 'test', path: '/status', value: 'finished' },
          { op: 'replace', path: '/status', value: 'cancelled' },
        ]),
        `${name} JSON Patch status`
      );
      expectForbidden(await a.patch(`Encounter/${encId}`, [{ op: 'remove', path: '/extension' }]), `${name} remove signature`);
      expectForbidden(
        await a.patch(`Procedure/${signed.procedure.id}`, [{ op: 'remove', path: '/meta/security' }]),
        `${name} remove lock label`
      );
      expectForbidden(
        await a.patch(`Condition/${signed.condition.id}`, [{ op: 'replace', path: '/meta', value: {} }]),
        `${name} replace meta`
      );
      expectForbidden(
        await a.patch(`DocumentReference/${docId}`, [
          { op: 'replace', path: '/content/0/attachment/data', value: Buffer.from('tampered').toString('base64') },
        ]),
        `${name} patch note content`
      );
      expectForbidden(
        await a.patch(`QuestionnaireResponse/${signed.questionnaireResponse.id}`, [
          { op: 'replace', path: '/status', value: 'in-progress' },
        ]),
        `${name} patch QR status`
      );
      // $-operations that write
      expectForbidden(await a.request('POST', `Encounter/${encId}/$refresh-reference-display`, {}), `${name} $refresh-reference-display`);
      expectForbidden(
        await a.request('POST', `Encounter/${encId}/$set-accounts`, { resourceType: 'Parameters', parameter: [] }),
        `${name} $set-accounts`
      );
      expectForbidden(await a.request('POST', `DocumentReference/${docId}/$expunge`, {}), `${name} $expunge`);
      // delete paths
      expectForbidden(await a.delete(`Encounter?_id=${encId}`), `${name} conditional DELETE`);
      expectForbidden(await a.delete(`DocumentReference/${docId}`), `${name} DELETE note`);
      // there is no write path into _history
      denied(await a.delete(`Encounter/${encId}/_history/${signed.encounter.meta?.versionId}`), 'DELETE _history');
      denied(await a.request('PUT', `Encounter/${encId}/_history/${signed.encounter.meta?.versionId}`, reverted), 'PUT _history');
      // GraphQL mutations go through the same repository checks
      expectGraphqlDenied(
        await graphql(
          a,
          `mutation { EncounterUpdate(id: "${encId}", res: { resourceType: "Encounter", id: "${encId}", status: "in-progress", class: { code: "AMB" }, subject: { reference: "${patientRef}" } }) { id } }`
        ),
        `${name} GraphQL EncounterUpdate`
      );
      expectGraphqlDenied(await graphql(a, `mutation { EncounterDelete(id: "${encId}") { id } }`), `${name} GraphQL EncounterDelete`);
      expectGraphqlDenied(
        await graphql(
          a,
          `mutation { DocumentReferenceUpdate(id: "${docId}", res: { resourceType: "DocumentReference", id: "${docId}", status: "current", docStatus: "preliminary", content: [{ attachment: { contentType: "text/plain", data: "dGFtcGVyZWQ=" } }] }) { id } }`
        ),
        `${name} GraphQL DocumentReferenceUpdate`
      );
      // upsert-create a signed Encounter at a chosen id / via conditional update
      const newId = crypto.randomUUID();
      denied(await a.request('PUT', `Encounter/${newId}`, { ...strip(signed.encounter), id: newId }), 'PUT-create at new id');
      denied(
        await a.request('PUT', `Encounter?identifier=urn:synthetic|${newId}`, {
          ...strip(signed.encounter),
          id: undefined,
          identifier: [{ system: 'urn:synthetic', value: newId }],
        }),
        'conditional PUT-create of a finished Encounter'
      );
    }

    // Nothing changed: current == signed version, and no extra versions were written.
    const after = await fx.superAdmin.get(`Encounter/${encId}`);
    expect(strip(after.body)).toEqual(strip(signed.encounter));
    expect(after.body.meta.versionId).toBe(signed.encounter.meta?.versionId);
    for (const r of [signed.noteDocument, signed.questionnaireResponse, signed.condition, signed.procedure]) {
      const cur = await fx.superAdmin.get(`${r.resourceType}/${r.id}`);
      expect(cur.body.meta.versionId, `${r.resourceType} version`).toBe(r.meta?.versionId);
    }
    const docHistory = await fx.superAdmin.get(`DocumentReference/${docId}/_history`);
    expect(docHistory.body.entry).toHaveLength(1);
  });

  test('Binary content cannot be replaced by any role (raw PUT, FHIR PUT, PATCH, DELETE)', async () => {
    const bin = await fx.a.actors.integration.create({ resourceType: 'Binary', contentType: 'text/plain', data: 'b3JpZ2luYWw=' });
    expectAllowed(bin, 'integration creates Binary');
    for (const [name, a] of everyRole()) {
      expectForbidden(await rawBinaryPut(a, bin.body.id), `${name} raw PUT Binary`);
      expectForbidden(await a.update({ ...bin.body, data: 'dGFtcGVyZWQ=' }), `${name} FHIR PUT Binary`);
      expectForbidden(await a.patch(`Binary/${bin.body.id}`, [{ op: 'replace', path: '/contentType', value: 'text/html' }]), `${name} PATCH Binary`);
      expectForbidden(await a.delete(`Binary/${bin.body.id}`), `${name} DELETE Binary`);
    }
    const res = await fetch(`${BASE_URL}fhir/R4/Binary/${bin.body.id}`, {
      headers: { Authorization: `Bearer ${fx.superAdmin.client.getAccessToken()}`, Accept: 'text/plain' },
    });
    expect(await res.text()).toBe('original');
  });

  test('no role can create or change admin/security resources (privilege escalation)', async () => {
    for (const [name, a] of everyRole()) {
      for (const resource of [
        { resourceType: 'AccessPolicy', name: 'evil', resource: [{ resourceType: '*' }] },
        { resourceType: 'ClientApplication', name: 'evil' },
        { resourceType: 'Bot', name: 'evil' },
        { resourceType: 'Subscription', status: 'active', reason: 'x', criteria: 'Encounter', channel: { type: 'rest-hook', endpoint: 'https://example.invalid' } },
        { resourceType: 'ProjectMembership', project: { reference: `Project/${fx.a.projectId}` }, user: { reference: 'User/x' }, profile: { reference: pract } },
        { resourceType: 'Project', name: 'evil' },
      ]) {
        expectForbidden(await a.create(resource as any), `${name} create ${resource.resourceType}`);
      }
      expectForbidden(await a.request('POST', `admin/projects/${fx.a.projectId}/client`, { name: 'evil' }), `${name} admin client API`);
      expectStatus(await a.get(`admin/projects/${fx.a.projectId}`), [403, 404], `${name} admin project API`);
    }
  });

  test('new rule: a preliminary "addendum" (appends, not final) is refused, so every addendum is locked from birth', async () => {
    const { integration, provider } = fx.a.actors;
    for (const [name, a] of [
      ['integration', integration],
      ['provider', provider],
    ] as const) {
      const r = await a.create(addendum(signed, pract, { docStatus: 'preliminary' }));
      expectForbidden(r, `${name} preliminary addendum`);
      const noStatus = await a.create(addendum(signed, pract, { docStatus: undefined }));
      expectForbidden(noStatus, `${name} addendum without docStatus`);
    }
    // an existing preliminary document cannot be turned into an addendum later either
    const draft = await integration.create({ ...addendum(signed, pract), docStatus: 'preliminary', relatesTo: undefined });
    expectAllowed(draft, 'preliminary unrelated document');
    expectForbidden(
      await integration.update({ ...draft.body, relatesTo: addendum(signed, pract).relatesTo }),
      'add appends relation to preliminary document'
    );
  });

  test('new rule: a draft child record cannot be moved into (or out of) a signed encounter', async () => {
    const { integration, provider } = fx.a.actors;
    const draft = await writeDraftNote(integration, patientRef, pract);
    for (const [name, a] of [
      ['integration', integration],
      ['provider', provider],
    ] as const) {
      expectForbidden(
        await a.update({ ...draft.procedure, encounter: { reference: `Encounter/${signed.encounter.id}` } }),
        `${name} move Procedure into signed encounter`
      );
      expectForbidden(
        await a.patch(`Condition/${draft.condition.id}`, [
          { op: 'replace', path: '/encounter/reference', value: `Encounter/${signed.encounter.id}` },
        ]),
        `${name} move Condition into signed encounter`
      );
      expectForbidden(
        await a.update({ ...draft.questionnaireResponse, encounter: { reference: `Encounter/${signed.encounter.id}` } }),
        `${name} move QR into signed encounter`
      );
    }
    // ordinary draft edits still work
    expectAllowed(await integration.update({ ...draft.procedure, note: [{ text: 'synthetic edit' }] }), 'draft edit');
  });

  test('read side channels: front office cannot reach diagnoses through _revinclude/_has/chaining/$everything', async () => {
    const fo = fx.a.actors.front_office;
    const encId = signed.encounter.id;
    for (const q of [
      `Encounter?_id=${encId}&_revinclude=Condition:encounter`,
      `Encounter?_id=${encId}&_has:Condition:encounter:code=M54.50`,
      `Patient?_id=${fx.a.patient.id}&_has:Condition:subject:code=M54.50`,
      `Encounter?_id=${encId}&diagnosis:Condition.code=M54.50`,
    ]) {
      expectForbidden(await fo.get(q), `front_office ${q}`);
    }
    const everything = await fo.get(`Patient/${fx.a.patient.id}/$everything`);
    expectAllowed(everything, 'front_office $everything');
    const types = new Set((everything.body.entry ?? []).map((e: any) => e.resource.resourceType));
    for (const t of ['Condition', 'Procedure', 'DocumentReference', 'QuestionnaireResponse']) {
      expect(types.has(t), `$everything leaks ${t}`).toBe(false);
    }
    for (const e of everything.body.entry ?? []) {
      if (e.resource.resourceType === 'Encounter') {
        expect(e.resource.extension, 'hidden Encounter.extension').toBeUndefined();
        expect(e.resource.diagnosis, 'hidden Encounter.diagnosis').toBeUndefined();
      }
    }
    const hist = await fo.get(`Encounter/${encId}/_history`);
    expectAllowed(hist, 'front_office Encounter history');
    for (const e of hist.body.entry ?? []) {
      expect(e.resource.extension, 'hidden field in _history').toBeUndefined();
    }
  });

  test('practice_admin never sees a client secret (read, search, _history, _elements, GraphQL)', async () => {
    const pa = fx.a.actors.practice_admin;
    const { id, secret } = fx.a.integrationClient;
    for (const q of ['ClientApplication', `ClientApplication/${id}`, `ClientApplication/${id}/_history`, 'ClientApplication?_elements=secret,retiringSecret']) {
      const r = await pa.get(q);
      expectAllowed(r, `practice_admin ${q}`);
      expect(JSON.stringify(r.body).includes(secret), `secret leaked by ${q}`).toBe(false);
    }
    const g = await graphql(pa, `{ ClientApplicationList { id secret retiringSecret } }`);
    expect(JSON.stringify(g.body).includes(secret)).toBe(false);
  });

  // ------------------------------------------------------------------ known gaps (documented, not fixable by policy)

  test('KNOWN GAP: NEW child resources can still be attached to a signed encounter by provider / integration', async () => {
    // AccessPolicy writeConstraints are evaluated on the written resource only; FHIRPath cannot dereference
    // Procedure.encounter to see that the Encounter is finished. So a new Procedure / Condition / completed
    // QuestionnaireResponse / competing final progress note that points at the signed encounter is accepted.
    // The billing app's getBillingContext loads children by `encounter=` search and bills them without
    // re-verifying the signed content hash (billing patch docs/medplum/patches/0003). Server-side fix proposal:
    // README "Known gaps" (reference-aware write constraint or pre-commit guard).
    const { integration, provider } = fx.a.actors;
    const encRef = { reference: `Encounter/${signed.encounter.id}` };
    for (const [name, a] of [
      ['integration', integration],
      ['provider', provider],
    ] as const) {
      const proc = await a.create({
        resourceType: 'Procedure',
        status: 'completed',
        code: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '97140' }] },
        subject: { reference: patientRef },
        encounter: encRef,
        performer: [{ actor: { reference: pract } }],
      } as any);
      expectStatus(proc, 201, `${name} new Procedure on signed encounter (gap)`);
      const note = await a.create({
        ...addendum(signed, pract),
        relatesTo: undefined,
        type: { coding: [{ system: LOINC_SYSTEM, code: LOINC_PROGRESS_NOTE }] },
      });
      expectStatus(note, 201, `${name} competing final progress note (gap)`);
      // ...but whatever was added is itself immutable from birth when final:
      expectForbidden(await a.update({ ...note.body, description: 'x' }), `${name} competing note is locked`);
    }
    // Biller, front office, practice admin and the AI service cannot do this (no clinical create).
    for (const role of ['biller', 'rcm_supervisor', 'front_office', 'practice_admin', 'ai_service'] as const) {
      const r = await fx.a.actors[role].create({
        resourceType: 'Procedure',
        status: 'completed',
        code: { text: 'x' },
        subject: { reference: patientRef },
        encounter: encRef,
      } as any);
      expectForbidden(r, `${role} new Procedure on signed encounter`);
    }
  });

  test('KNOWN GAP: any authenticated identity can call Project/$init (outside AccessPolicy)', async () => {
    // Upstream projectInitHandler has no super-admin check. ClientApplications (AI service, integration) can
    // create empty projects; a project-scoped user can create a project for a NEW server-scoped User by email.
    // No access to practice data results, but it is an unbounded write outside the practice. Proposal in README.
    const r = await fx.a.actors.ai_service.request('POST', 'Project/$init', {
      resourceType: 'Parameters',
      parameter: [{ name: 'name', valueString: `synthetic-gap-${fx.a.run}` }],
    });
    expectStatus(r, 201, 'ai_service Project/$init (gap)');
  });

  test('KNOWN GAP: references are not validated, so a practice-A record may point at a practice-B id (or at nothing)', async () => {
    // Project.checkReferencesOnWrite would refuse these, but the billing app writes references that do not
    // resolve in Medplum today (Encounter plan-of-care extension -> CarePlan/<billing id>), so enabling it breaks
    // saveNote (verified live). The dangling reference exposes no B data: reads of it stay 404 for A.
    for (const [name, a] of everyRole()) {
      const cross = await a.create({
        resourceType: 'Task',
        status: 'requested',
        intent: 'order',
        for: { reference: `Patient/${fx.b.patient.id}` },
      } as any);
      expectStatus(cross, 201, `${name} Task referencing practice B patient (gap)`);
      expectStatus(await a.get(`Patient/${fx.b.patient.id}`), [403, 404], `${name} still cannot read B patient`);
    }
  });

  test('KNOWN GAP: hidden fields are still searchable (existence oracle), e.g. AI service on Patient.telecom', async () => {
    // hiddenFields strips the value from responses, but search parameters on the hidden element still filter.
    const ai = fx.a.actors.ai_service;
    const hit = await ai.get(`Patient?_id=${fx.a.patient.id}&phone=555-0100`);
    const miss = await ai.get(`Patient?_id=${fx.a.patient.id}&phone=555-9999`);
    expect(hit.body.entry ?? []).toHaveLength(1);
    expect(miss.body.entry ?? []).toHaveLength(0);
    expect(hit.body.entry[0].resource.telecom).toBeUndefined();
  });
});
