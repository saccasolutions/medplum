// Empirical answer to "who bypasses AccessPolicy?" on this Medplum version.
// These tests assert the ACTUAL server behaviour so a Medplum upgrade that changes it is noticed.
// Outcomes marked BYPASS are why no day-to-day identity may be a super admin, a project admin,
// or a ClientApplication/membership without an AccessPolicy (README "Who bypasses AccessPolicy").

import { createReference } from '@medplum/core';
import type { Encounter, ProjectMembership } from '@medplum/fhirtypes';
import type { Fixture, SignedNote } from './fixture';
import { PASSWORD, setupFixture, signNote, writeDraftNote } from './fixture';
import { Actor, LIVE, clientLogin, expectForbidden, expectStatus, passwordLogin } from './harness';

describe.skipIf(!LIVE)('Who bypasses AccessPolicy (live server)', () => {
  let fx: Fixture;
  const sign = async (): Promise<SignedNote> => {
    const pRef = fx.a.practitioner.reference as string;
    const { integration } = fx.a.actors;
    return signNote(integration, await writeDraftNote(integration, `Patient/${fx.a.patient.id}`, pRef), pRef, {
      lockChildren: true,
    });
  };

  beforeAll(async () => {
    fx = await setupFixture();
  }, 180_000);

  test('BYPASS: super admin (no AccessPolicy) can modify and delete signed content', async () => {
    const s = await sign();
    const r = await fx.superAdmin.update<Encounter>({ ...s.encounter, status: 'in-progress' });
    expectStatus(r, 200, 'super admin reverts signed encounter');
    expectStatus(await fx.superAdmin.delete(`DocumentReference/${s.noteDocument.id}`), 200, 'super admin deletes note');
  });

  test('BYPASS: a ClientApplication created WITHOUT an AccessPolicy gets legacy full access', async () => {
    const s = await sign();
    const raw = await fx.superAdmin.request('POST', `admin/projects/${fx.a.projectId}/client`, {
      name: `no-policy-${fx.a.run}`,
    });
    expectStatus(raw, 201, 'create client without policy');
    const c = new Actor('no-policy-client', await clientLogin(raw.body.id, raw.body.secret));
    expectStatus(
      await c.update<Encounter>({ ...s.encounter, status: 'in-progress' }),
      200,
      'no-policy client edits signed'
    );
  });

  describe('project admin (membership.admin = true) holding the practice_admin policy', () => {
    let admin: Actor;
    let membership: ProjectMembership & { id: string };

    beforeAll(async () => {
      const email = `project-admin-${fx.a.run}@synthetic.example.com`;
      const res = await fx.superAdmin.request('POST', `admin/projects/${fx.a.projectId}/invite`, {
        resourceType: 'Practitioner',
        firstName: 'Synthetic',
        lastName: 'ProjectAdmin',
        email,
        password: PASSWORD,
        scope: 'project',
        sendEmail: false,
        membership: { admin: true, accessPolicy: createReference(fx.a.policies.practice_admin) },
      });
      expectStatus(res, 200, 'invite project admin');
      membership = res.body;
      admin = new Actor('project_admin', await passwordLogin(email, PASSWORD, fx.a.projectId));
    }, 60_000);

    test('ordinary FHIR writes still obey the AccessPolicy (lock holds)', async () => {
      const s = await sign();
      expectForbidden(await admin.update<Encounter>({ ...s.encounter, status: 'in-progress' }), 'PUT signed');
      expectForbidden(await admin.delete(`DocumentReference/${s.noteDocument.id}`), 'DELETE signed note');
    });

    test('BYPASS: $expunge permanently destroys a signed note and its history', async () => {
      const s = await sign();
      const r = await admin.request('POST', `DocumentReference/${s.noteDocument.id}/$expunge`, {});
      expectStatus(r, 200, '$expunge signed note');
      expectStatus(await fx.a.actors.integration.get(`DocumentReference/${s.noteDocument.id}`), 404, 'note gone');
      expectStatus(
        await fx.a.actors.integration.get(`DocumentReference/${s.noteDocument.id}/_history`),
        [404, 410],
        'history gone'
      );
    });

    test('BYPASS: can strip the AccessPolicy from its own membership and then edit signed content', async () => {
      const s = await sign();
      const current = await admin.get(`ProjectMembership/${membership.id}`);
      expectStatus(current, 200, 'read own membership');
      const { accessPolicy: _drop, ...rest } = current.body;
      expectStatus(await admin.update(rest), 200, 'remove own accessPolicy');
      const email = `project-admin-${fx.a.run}@synthetic.example.com`;
      const relogged = new Actor('project_admin(relogin)', await passwordLogin(email, PASSWORD, fx.a.projectId));
      expectStatus(await relogged.update<Encounter>({ ...s.encounter, status: 'in-progress' }), 200, 'edit signed');
    });

    test('BYPASS: can mint a ClientApplication without an AccessPolicy via the admin API', async () => {
      const r = await admin.request('POST', `admin/projects/${fx.a.projectId}/client`, {
        name: `pa-minted-${fx.a.run}`,
      });
      expectStatus(r, 201, 'project admin creates unrestricted client');
    });
  });
});
