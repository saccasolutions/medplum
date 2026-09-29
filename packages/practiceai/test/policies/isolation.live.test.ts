// Cross-project isolation (plan §6.1: one Medplum project per practice).

import type { Fixture, SignedNote } from './fixture';
import { setupFixture, signNote, writeDraftNote } from './fixture';
import { LIVE, expectForbidden, expectStatus } from './harness';

describe.skipIf(!LIVE)('Cross-project isolation (live server)', () => {
  let fx: Fixture;
  let signedB: SignedNote;

  beforeAll(async () => {
    fx = await setupFixture();
    const pRef = fx.b.practitioner.reference as string;
    signedB = await signNote(
      fx.b.actors.integration,
      await writeDraftNote(fx.b.actors.integration, `Patient/${fx.b.patient.id}`, pRef),
      pRef,
      { lockChildren: true }
    );
  }, 180_000);

  test('no role in practice A can read practice B resources (read or search)', async () => {
    for (const [name, actor] of Object.entries(fx.a.actors)) {
      for (const path of [
        `Patient/${fx.b.patient.id}`,
        `Coverage/${fx.b.coverage.id}`,
        `Encounter/${signedB.encounter.id}`,
        `DocumentReference/${signedB.noteDocument.id}`,
      ]) {
        const r = await actor.get(path);
        // 404 when the type is readable (row filtered by project), 403 when the role cannot read the type at all.
        expectStatus(r, [403, 404], `${name} GET B ${path}`);
      }
      const s = await actor.get(`Patient?_id=${fx.b.patient.id}`);
      if (s.status === 200) {
        expect(s.body.entry ?? []).toHaveLength(0);
      } else {
        expectStatus(s, 403, `${name} search B patient`);
      }
      const h = await actor.get(`Encounter/${signedB.encounter.id}/_history`);
      expectStatus(h, [403, 404], `${name} history B encounter`);
    }
  });

  test('no role in practice A can write into practice B', async () => {
    for (const [name, actor] of Object.entries(fx.a.actors)) {
      const r = await actor.update({ ...fx.b.patient, birthDate: '1960-01-01' });
      expectStatus(r, [403, 404], `${name} PUT B patient`);
      expectStatus(await actor.delete(`Patient/${fx.b.patient.id}`), [403, 404], `${name} DELETE B patient`);
      // meta.project is protected: a write cannot be redirected to B.
      const created = await actor.create({
        resourceType: 'Task',
        status: 'requested',
        intent: 'order',
        meta: { project: fx.b.projectId },
      } as any);
      if (created.status === 201) {
        const inA = await fx.superAdmin.get(`Task?_id=${created.body.id}&_project=${fx.a.projectId}`);
        expect(inA.body.entry ?? []).toHaveLength(1);
        expectStatus(await fx.b.actors.integration.get(`Task/${created.body.id}`), 404, 'Task not visible in B');
      } else {
        expectForbidden(created, `${name} create Task`);
      }
    }
  });

  test('practice B identities cannot read practice A', async () => {
    for (const [name, actor] of Object.entries(fx.b.actors)) {
      expectStatus(await actor.get(`Patient/${fx.a.patient.id}`), [403, 404], `${name} GET A patient`);
    }
  });
});
