// Signed-encounter lock against the REAL server (ENC-02, AI-03, plan §4).
// Run: MEDPLUM_BASE_URL=http://localhost:8103 npx vitest run --config test/policies/vitest.live.config.ts

import type { DocumentReference, Encounter } from '@medplum/fhirtypes';
import type { PracticeRole } from '../../src/policies';
import { SIGNED_LOCK_REASONS, SIGNED_LOCK_SECURITY } from '../../src/policies';
import type { Fixture, SignedNote } from './fixture';
import { addendum, draftEncounter, setupFixture, signNote, strip, writeDraftNote } from './fixture';
import type { Actor } from './harness';
import { LIVE, expectAllowed, expectForbidden, expectLockDenied, expectStatus } from './harness';

describe.skipIf(!LIVE)('Signed-encounter lock (live server)', () => {
  let fx: Fixture;
  let appSigned: SignedNote; // signed by the integration client, children lock-labelled
  let providerSigned: SignedNote; // signed directly by the provider in Medplum
  let unlabelled: SignedNote; // signed by the integration client with the app's CURRENT transaction (no labels)

  beforeAll(async () => {
    fx = await setupFixture();
    const { integration, provider } = fx.a.actors;
    const patientRef = `Patient/${fx.a.patient.id}`;
    const pract = fx.a.practitioner.reference as string;

    appSigned = await signNote(integration, await writeDraftNote(integration, patientRef, pract), pract, {
      lockChildren: true,
    });
    providerSigned = await signNote(provider, await writeDraftNote(provider, patientRef, pract), pract, {
      lockChildren: true,
    });
    unlabelled = await signNote(integration, await writeDraftNote(integration, patientRef, pract), pract);
  }, 180_000);

  const everyRole = (): [string, Actor][] => Object.entries(fx.a.actors);

  test('signing transaction set status finished, QR completed, final note, lock labels on children', () => {
    for (const s of [appSigned, providerSigned]) {
      expect(s.encounter.status).toBe('finished');
      expect(s.questionnaireResponse.status).toBe('completed');
      expect(s.noteDocument.docStatus).toBe('final');
      for (const child of [s.condition, s.procedure]) {
        expect(child.meta?.security?.some((c) => c.code === SIGNED_LOCK_SECURITY.code)).toBe(true);
      }
    }
  });

  test('every role (incl. provider and integration client): PUT of a signed Encounter is 403', async () => {
    for (const [name, actor] of everyRole()) {
      for (const s of [appSigned, providerSigned]) {
        const r = await actor.update<Encounter>({ ...s.encounter, period: { start: '2026-08-01T09:00:00Z' } });
        expectForbidden(r, `${name} PUT signed Encounter`);
      }
    }
  });

  test('every role: status revert (PUT and PATCH finished -> in-progress) is 403', async () => {
    for (const [name, actor] of everyRole()) {
      const put = await actor.update<Encounter>({ ...appSigned.encounter, status: 'in-progress' });
      expectForbidden(put, `${name} PUT status revert`);
      const patch = await actor.patch(`Encounter/${appSigned.encounter.id}`, [
        { op: 'replace', path: '/status', value: 'in-progress' },
      ]);
      expectForbidden(patch, `${name} PATCH status revert`);
      const cancel = await actor.patch(`Encounter/${providerSigned.encounter.id}`, [
        { op: 'replace', path: '/status', value: 'entered-in-error' },
      ]);
      expectForbidden(cancel, `${name} PATCH status entered-in-error`);
      const unsign = await actor.patch(`Encounter/${appSigned.encounter.id}`, [{ op: 'remove', path: '/extension' }]);
      expectForbidden(unsign, `${name} PATCH remove signature`);
    }
  });

  test('every role: DELETE of signed Encounter / note / QR / Condition / Procedure is 403', async () => {
    for (const [name, actor] of everyRole()) {
      for (const path of [
        `Encounter/${appSigned.encounter.id}`,
        `DocumentReference/${appSigned.noteDocument.id}`,
        `QuestionnaireResponse/${appSigned.questionnaireResponse.id}`,
        `Condition/${appSigned.condition.id}`,
        `Procedure/${appSigned.procedure.id}`,
      ]) {
        expectForbidden(await actor.delete(path), `${name} DELETE ${path}`);
      }
    }
  });

  test('every role: signed note DocumentReference, QR, Condition, Procedure cannot be modified (PUT/PATCH)', async () => {
    for (const [name, actor] of everyRole()) {
      const s = appSigned;
      expectForbidden(
        await actor.update<DocumentReference>({ ...s.noteDocument, description: 'silently rewritten' }),
        `${name} PUT signed note`
      );
      expectForbidden(
        await actor.patch(`DocumentReference/${s.noteDocument.id}`, [
          { op: 'replace', path: '/docStatus', value: 'preliminary' },
        ]),
        `${name} PATCH signed note docStatus`
      );
      expectForbidden(
        await actor.patch(`DocumentReference/${s.noteDocument.id}`, [
          { op: 'replace', path: '/status', value: 'entered-in-error' },
        ]),
        `${name} PATCH signed note status`
      );
      expectForbidden(
        await actor.patch(`QuestionnaireResponse/${s.questionnaireResponse.id}`, [
          { op: 'replace', path: '/status', value: 'in-progress' },
        ]),
        `${name} PATCH signed QR`
      );
      expectForbidden(
        await actor.patch(`Procedure/${s.procedure.id}`, [
          { op: 'replace', path: '/code/coding/0/code', value: '97112' },
        ]),
        `${name} PATCH locked Procedure`
      );
      expectForbidden(
        await actor.patch(`Condition/${s.condition.id}`, [
          { op: 'replace', path: '/code/coding/0/code', value: 'M54.2' },
        ]),
        `${name} PATCH locked Condition`
      );
      expectForbidden(
        await actor.patch(`Procedure/${s.procedure.id}`, [{ op: 'remove', path: '/meta/security' }]),
        `${name} PATCH remove lock label`
      );
    }
  });

  test('a transaction that touches signed content fails as a whole', async () => {
    const { integration } = fx.a.actors;
    const draft = await writeDraftNote(
      integration,
      `Patient/${fx.a.patient.id}`,
      fx.a.practitioner.reference as string
    );
    const r = await integration.transaction([
      {
        request: { method: 'PUT', url: `Encounter/${draft.encounter.id}` },
        resource: { ...draft.encounter, period: { start: '2026-09-02T09:00:00Z' } },
      },
      {
        request: { method: 'PUT', url: `Encounter/${appSigned.encounter.id}` },
        resource: { ...appSigned.encounter, status: 'in-progress' },
      },
    ]);
    expectForbidden(r, 'transaction with signed Encounter');
    const after = await integration.get(`Encounter/${draft.encounter.id}`);
    expect(after.body.meta.versionId).toBe(draft.encounter.meta?.versionId);
  });

  test('unsigned drafts stay editable by the integration client and the treating provider', async () => {
    const { integration, provider } = fx.a.actors;
    const draft = await writeDraftNote(
      integration,
      `Patient/${fx.a.patient.id}`,
      fx.a.practitioner.reference as string
    );
    expectAllowed(
      await integration.update({ ...draft.encounter, period: { start: '2026-09-03T09:00:00Z' } }),
      'integration edits draft Encounter'
    );
    expectAllowed(
      await provider.patch(`Procedure/${draft.procedure.id}`, [
        { op: 'replace', path: '/code/coding/0/code', value: '97112' },
      ]),
      'provider edits draft Procedure'
    );
    expectAllowed(
      await integration.patch(`Condition/${draft.condition.id}`, [
        { op: 'replace', path: '/verificationStatus/coding/0/code', value: 'entered-in-error' },
      ]),
      'integration retires draft Condition'
    );
    // but never deletes, even drafts
    expectForbidden(await integration.delete(`Procedure/${draft.procedure.id}`), 'integration DELETE draft Procedure');
  });

  test('clinical records cannot be moved to another patient', async () => {
    const { integration } = fx.a.actors;
    const other = await integration.create({ resourceType: 'Patient', name: [{ family: 'Synthetic-Other' }] });
    const draft = await writeDraftNote(
      integration,
      `Patient/${fx.a.patient.id}`,
      fx.a.practitioner.reference as string
    );
    expectForbidden(
      await integration.update({ ...draft.condition, subject: { reference: `Patient/${other.body.id}` } }),
      'move Condition to another patient'
    );
  });

  test('an Encounter cannot be created already finished/signed', async () => {
    for (const role of ['integration', 'provider'] as PracticeRole[]) {
      const enc = draftEncounter(`Patient/${fx.a.patient.id}`, fx.a.practitioner.reference as string);
      expectForbidden(
        await fx.a.actors[role].create<Encounter>({ ...enc, status: 'finished' }),
        `${role} create finished`
      );
    }
  });

  test('addendum: a NEW DocumentReference (appends, author, date) is allowed; the original is unchanged in history', async () => {
    const { integration, provider } = fx.a.actors;
    const pract = fx.a.practitioner.reference as string;
    const before = await integration.get(`DocumentReference/${appSigned.noteDocument.id}/_history`);
    expectStatus(before, 200, 'history before addendum');

    const viaApp = await integration.create(addendum(appSigned, pract));
    expectAllowed(viaApp, 'integration creates addendum');
    const viaProvider = await provider.create(addendum(providerSigned, pract));
    expectAllowed(viaProvider, 'provider creates own addendum');

    // Addenda are themselves immutable once final.
    expectForbidden(
      await integration.update({ ...viaApp.body, description: 'edited addendum' }),
      'edit final addendum'
    );
    expectForbidden(await provider.delete(`DocumentReference/${viaProvider.body.id}`), 'delete addendum');

    // Original: single version, identical to what was signed (vread + history).
    for (const s of [appSigned, providerSigned]) {
      const hist = await integration.get(`DocumentReference/${s.noteDocument.id}/_history`);
      expect(hist.body.entry).toHaveLength(1);
      const vread = await integration.get(
        `DocumentReference/${s.noteDocument.id}/_history/${s.noteDocument.meta?.versionId}`
      );
      expectStatus(vread, 200, 'vread original');
      expect(strip(vread.body)).toEqual(strip(s.noteDocument));
      const current = await integration.get(`DocumentReference/${s.noteDocument.id}`);
      expect(current.body.meta.versionId).toBe(s.noteDocument.meta?.versionId);
      const enc = await integration.get(`Encounter/${s.encounter.id}/_history`);
      expect(enc.body.entry[0].resource.meta.versionId).toBe(s.encounter.meta?.versionId);
    }
    expect(before.body.entry).toHaveLength(1);

    // The addendum is linked to the original.
    const search = await integration.get(`DocumentReference?relatesto=DocumentReference/${appSigned.noteDocument.id}`);
    expectStatus(search, 200, 'search addenda');
    expect(search.body.entry?.map((e: any) => e.resource.id)).toContain(viaApp.body.id);
  });

  test('addendum rules: no author/date, or replaces/transforms relation, is 403', async () => {
    const { integration } = fx.a.actors;
    const pract = fx.a.practitioner.reference as string;
    expectForbidden(await integration.create(addendum(appSigned, pract, { author: undefined })), 'addendum w/o author');
    expectForbidden(await integration.create(addendum(appSigned, pract, { date: undefined })), 'addendum w/o date');
    for (const code of ['replaces', 'transforms', 'signs'] as const) {
      expectForbidden(
        await integration.create(
          addendum(appSigned, pract, {
            relatesTo: [{ code, target: { reference: `DocumentReference/${appSigned.noteDocument.id}` } }],
          })
        ),
        `document that ${code} the signed note`
      );
    }
  });

  test('provider may author addenda only as themself', async () => {
    const { provider, provider2 } = fx.a.actors;
    expectForbidden(
      await provider2.create(addendum(providerSigned, fx.a.practitioner.reference as string)),
      'provider2 authors addendum as provider1'
    );
    expectAllowed(
      await provider2.create(addendum(providerSigned, fx.a.practitioner2.reference as string)),
      'provider2 authors own addendum'
    );
    expect(provider).toBeDefined();
  });

  test('Binary is create/read only (content referenced by signed documents cannot be overwritten)', async () => {
    const { integration } = fx.a.actors;
    const bin = await integration.create({ resourceType: 'Binary', contentType: 'text/plain', data: 'c3ludGhldGlj' });
    expectAllowed(bin, 'create Binary');
    expectForbidden(await integration.update({ ...bin.body, data: 'dGFtcGVyZWQ=' }), 'overwrite Binary');
    expectForbidden(await integration.delete(`Binary/${bin.body.id}`), 'delete Binary');
  });

  test('CLOSED (server guard): without the lock label, Condition/Procedure of an app-signed encounter are locked', async () => {
    // The app's current signEncounter transaction does not touch Condition/Procedure, and AccessPolicy
    // writeConstraints cannot dereference Procedure.encounter. The fork's server guard
    // (packages/server/src/practiceai/guard.ts, enabled by Project.systemSetting practiceai-signed-lock) resolves
    // the encounter server-side and refuses edits/deletes of every child of a finished encounter, labelled or not.
    const { integration, provider } = fx.a.actors;
    expectForbidden(
      await integration.update({ ...unlabelled.encounter, status: 'in-progress' }),
      'unlabelled: Encounter still locked'
    );
    expectForbidden(
      await integration.update({ ...unlabelled.noteDocument, description: 'x' }),
      'unlabelled: note still locked'
    );
    for (const [name, a] of [
      ['integration', integration],
      ['provider', provider],
    ] as const) {
      const r = await a.patch(`Procedure/${unlabelled.procedure.id}`, [
        { op: 'replace', path: '/code/coding/0/code', value: '97140' },
      ]);
      expectLockDenied(r, SIGNED_LOCK_REASONS.signedEncounter, `${name}: unlabelled Procedure is locked`);
      expectLockDenied(
        await a.update({ ...unlabelled.condition, recordedDate: '2026-09-02' }),
        SIGNED_LOCK_REASONS.signedEncounter,
        `${name}: unlabelled Condition is locked`
      );
    }
    // DELETE is already refused by the policies (no role has delete on clinical types).
    expectForbidden(await integration.delete(`Condition/${unlabelled.condition.id}`), 'unlabelled Condition cannot be deleted');
    const stored = await fx.superAdmin.get(`Procedure/${unlabelled.procedure.id}`);
    expect(stored.body.meta.versionId).toBe(unlabelled.procedure.meta?.versionId);
  });
});
