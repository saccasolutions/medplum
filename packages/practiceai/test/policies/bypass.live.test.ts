// Empirical answer to "who bypasses the signed-content lock?" on this build.
// These tests assert the ACTUAL server behaviour so a Medplum upgrade (or a lost fork patch) that changes it is
// noticed. AccessPolicies alone are bypassed by super admins, project admins and identities without a policy;
// the fork's server guard (packages/server/src/practiceai/guard.ts, enabled per project by
// Project.systemSetting `practiceai-signed-lock`, set by provisioning / createPracticeProject) closes those
// bypasses for every identity except the super admin, whose writes to signed content are recorded as
// break-glass AuditEvents. The last block shows the upstream behaviour in a project WITHOUT the flag.

import { createReference } from '@medplum/core';
import type { AuditEvent, Encounter, Project, ProjectMembership } from '@medplum/fhirtypes';
import { SIGNED_LOCK_PROJECT_SETTING, SIGNED_LOCK_REASONS } from '../../src/policies';
import type { Fixture, SignedNote } from './fixture';
import { PASSWORD, addendum, setupFixture, signNote, writeDraftNote } from './fixture';
import {
  Actor,
  BASE_URL,
  LIVE,
  clientLogin,
  expectAllowed,
  expectForbidden,
  expectLockDenied,
  expectStatus,
  passwordLogin,
} from './harness';

describe.skipIf(!LIVE)('Who bypasses the signed-content lock (live server)', () => {
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

  test('practice projects carry the lock flag', async () => {
    const project = await fx.superAdmin.get(`Project/${fx.a.projectId}`);
    expect(project.body.systemSetting).toContainEqual({ name: SIGNED_LOCK_PROJECT_SETTING, valueBoolean: true });
  });

  test('BREAK-GLASS: super admin can still modify and delete signed content, and every such write is audited', async () => {
    const s = await sign();
    const r = await fx.superAdmin.update<Encounter>({ ...s.encounter, status: 'in-progress' });
    expectStatus(r, 200, 'super admin reverts signed encounter');
    expectStatus(await fx.superAdmin.delete(`DocumentReference/${s.noteDocument.id}`), 200, 'super admin deletes note');
    for (const target of [`Encounter/${s.encounter.id}`, `DocumentReference/${s.noteDocument.id}`]) {
      const audits = await fx.superAdmin.get(`AuditEvent?entity=${target}&_count=20`);
      expectStatus(audits, 200, 'search AuditEvent');
      const btg = ((audits.body.entry ?? []) as { resource: AuditEvent }[])
        .map((e) => e.resource)
        .filter((a) => a.purposeOfEvent?.[0]?.coding?.[0]?.code === 'BTG');
      expect(btg.length, `break-glass AuditEvent for ${target}`).toBeGreaterThan(0);
      expect(btg[0].outcomeDesc).toContain('PRACTICEAI break-glass');
    }
  });

  test('CLOSED: a ClientApplication WITHOUT an AccessPolicy (legacy full access) is still refused by the guard', async () => {
    const s = await sign();
    // The super admin can still create one (operations identity; routine config is not break-glass) ...
    const raw = await fx.superAdmin.request('POST', `admin/projects/${fx.a.projectId}/client`, {
      name: `no-policy-${fx.a.run}`,
    });
    expectStatus(raw, 201, 'super admin creates client without policy');
    const c = new Actor('no-policy-client', await clientLogin(raw.body.id, raw.body.secret));
    // ... but it cannot touch signed content, attach children, or create policies.
    expectLockDenied(
      await c.update<Encounter>({ ...s.encounter, status: 'in-progress' }),
      SIGNED_LOCK_REASONS.signedContent,
      'no-policy client edits signed'
    );
    expectLockDenied(
      await c.update({ ...s.procedure, code: { text: 'tampered' } }),
      SIGNED_LOCK_REASONS.signedContent,
      'no-policy client edits labelled Procedure'
    );
    expectLockDenied(
      await c.create({
        resourceType: 'Procedure',
        status: 'completed',
        code: { text: '97140' },
        subject: { reference: `Patient/${fx.a.patient.id}` },
        encounter: { reference: `Encounter/${s.encounter.id}` },
      }),
      SIGNED_LOCK_REASONS.signedEncounter,
      'no-policy client attaches Procedure'
    );
    expectLockDenied(
      await c.create({ resourceType: 'AccessPolicy', name: 'wildcard', resource: [{ resourceType: '*' }] }),
      SIGNED_LOCK_REASONS.accessPolicyAdmin,
      'no-policy client creates AccessPolicy'
    );
  });

  describe('project admin (membership.admin = true) holding the practice_admin policy', () => {
    let admin: Actor;
    let membership: ProjectMembership & { id: string };
    const email = (): string => `project-admin-${fx.a.run}@synthetic.example.com`;

    beforeAll(async () => {
      // Only the super admin can grant admin: true in a locked project.
      const res = await fx.superAdmin.request('POST', `admin/projects/${fx.a.projectId}/invite`, {
        resourceType: 'Practitioner',
        firstName: 'Synthetic',
        lastName: 'ProjectAdmin',
        email: email(),
        password: PASSWORD,
        scope: 'project',
        sendEmail: false,
        membership: { admin: true, accessPolicy: createReference(fx.a.policies.practice_admin) },
      });
      expectStatus(res, 200, 'invite project admin');
      membership = res.body;
      admin = new Actor('project_admin', await passwordLogin(email(), PASSWORD, fx.a.projectId));
    }, 60_000);

    test('ordinary FHIR writes still obey the AccessPolicy (lock holds)', async () => {
      const s = await sign();
      expectForbidden(await admin.update<Encounter>({ ...s.encounter, status: 'in-progress' }), 'PUT signed');
      expectForbidden(await admin.delete(`DocumentReference/${s.noteDocument.id}`), 'DELETE signed note');
    });

    test('CLOSED: $expunge of a signed note, a patient compartment or the project is refused', async () => {
      const s = await sign();
      expectLockDenied(
        await admin.request('POST', `DocumentReference/${s.noteDocument.id}/$expunge`, {}),
        SIGNED_LOCK_REASONS.expunge,
        '$expunge signed note'
      );
      expectLockDenied(
        await admin.request('POST', `Patient/${fx.a.patient.id}/$expunge?everything=true`, {}),
        SIGNED_LOCK_REASONS.expunge,
        '$expunge everything'
      );
      expectLockDenied(
        await admin.request('POST', `Project/${fx.a.projectId}/$expunge`, {}),
        SIGNED_LOCK_REASONS.expunge,
        '$expunge project'
      );
      expectStatus(await fx.a.actors.integration.get(`DocumentReference/${s.noteDocument.id}`), 200, 'note still there');
    });

    test('CLOSED: cannot strip the AccessPolicy from its own membership', async () => {
      const current = await admin.get(`ProjectMembership/${membership.id}`);
      expectStatus(current, 200, 'read own membership');
      const { accessPolicy: _drop, ...rest } = current.body;
      expectLockDenied(await admin.update(rest), SIGNED_LOCK_REASONS.membershipPolicyRequired, 'remove own accessPolicy');
      expectLockDenied(
        await admin.request('POST', `admin/projects/${fx.a.projectId}/members/${membership.id}`, rest),
        SIGNED_LOCK_REASONS.membershipPolicyRequired,
        'remove own accessPolicy via admin route'
      );
      expectLockDenied(
        await admin.patch(`ProjectMembership/${membership.id}`, [{ op: 'remove', path: '/accessPolicy' }]),
        SIGNED_LOCK_REASONS.membershipPolicyRequired,
        'PATCH remove own accessPolicy'
      );
    });

    test('CLOSED: cannot grant admin, or bind a policy from another project', async () => {
      const provider = await admin.get(`ProjectMembership/${fx.a.memberships.provider?.id}`);
      expectStatus(provider, 200, 'read provider membership');
      expectLockDenied(
        await admin.update({ ...provider.body, admin: true }),
        SIGNED_LOCK_REASONS.membershipAdmin,
        'grant admin'
      );
      expectLockDenied(
        await admin.update({ ...provider.body, accessPolicy: createReference(fx.b.policies.integration) }),
        SIGNED_LOCK_REASONS.membershipPolicyForeign,
        'bind practice B policy'
      );
    });

    test('CLOSED: cannot mint a ClientApplication / Bot / invite without an AccessPolicy', async () => {
      expectLockDenied(
        await admin.request('POST', `admin/projects/${fx.a.projectId}/client`, { name: `pa-minted-${fx.a.run}` }),
        SIGNED_LOCK_REASONS.membershipPolicyRequired,
        'project admin creates unrestricted client'
      );
      expectLockDenied(
        await admin.request('POST', `admin/projects/${fx.a.projectId}/bot`, { name: `pa-bot-${fx.a.run}` }),
        SIGNED_LOCK_REASONS.membershipPolicyRequired,
        'project admin creates unrestricted bot'
      );
      expectLockDenied(
        await admin.request('POST', `admin/projects/${fx.a.projectId}/invite`, {
          resourceType: 'Practitioner',
          firstName: 'Synthetic',
          lastName: 'Unrestricted',
          email: `pa-invite-${fx.a.run}@synthetic.example.com`,
          sendEmail: false,
        }),
        SIGNED_LOCK_REASONS.membershipPolicyRequired,
        'project admin invites user without policy'
      );
      expectLockDenied(
        await admin.request('POST', `admin/projects/${fx.a.projectId}/invite`, {
          resourceType: 'Practitioner',
          firstName: 'Synthetic',
          lastName: 'Admin2',
          email: `pa-invite-admin-${fx.a.run}@synthetic.example.com`,
          sendEmail: false,
          membership: { admin: true, accessPolicy: createReference(fx.a.policies.practice_admin) },
        }),
        SIGNED_LOCK_REASONS.membershipAdmin,
        'project admin invites another admin'
      );
    });

    test('CLOSED: cannot change Project.setting / checkReferencesOnWrite; systemSetting stays super-admin only', async () => {
      expectLockDenied(
        await admin.request('POST', `admin/projects/${fx.a.projectId}/settings`, [{ name: 'x', valueString: 'y' }]),
        SIGNED_LOCK_REASONS.projectSettings,
        'admin settings route'
      );
      const project = await admin.get(`Project/${fx.a.projectId}`);
      expectStatus(project, 200, 'read own project');
      expectLockDenied(
        await admin.update<Project>({ ...project.body, checkReferencesOnWrite: true }),
        SIGNED_LOCK_REASONS.projectSettings,
        'checkReferencesOnWrite'
      );
      // systemSetting is readonly for project admins upstream: a write that drops it is restored silently.
      await admin.update<Project>({ ...project.body, systemSetting: [] });
      await admin.patch(`Project/${fx.a.projectId}`, [{ op: 'remove', path: '/systemSetting' }]);
      const after = await fx.superAdmin.get(`Project/${fx.a.projectId}`);
      expect(after.body.systemSetting).toContainEqual({ name: SIGNED_LOCK_PROJECT_SETTING, valueBoolean: true });
    });
  });

  describe('project admin (admin = true) WITHOUT an AccessPolicy', () => {
    let admin: Actor;
    const email = (): string => `policyless-admin-${fx.a.run}@synthetic.example.com`;

    beforeAll(async () => {
      // Only the super admin can create this identity (break-glass setup, as in the adversarial review).
      const res = await fx.superAdmin.request('POST', `admin/projects/${fx.a.projectId}/invite`, {
        resourceType: 'Practitioner',
        firstName: 'Synthetic',
        lastName: 'PolicylessAdmin',
        email: email(),
        password: PASSWORD,
        scope: 'project',
        sendEmail: false,
        membership: { admin: true },
      });
      expectStatus(res, 200, 'invite policy-less project admin');
      admin = new Actor('policyless_admin', await passwordLogin(email(), PASSWORD, fx.a.projectId));
    }, 60_000);

    test('CLOSED: cannot overwrite, delete or get an upload URL for the Binary behind a signed note (or addendum)', async () => {
      const { integration } = fx.a.actors;
      const pRef = fx.a.practitioner.reference as string;
      const bin = await integration.create({
        resourceType: 'Binary',
        contentType: 'text/plain',
        data: Buffer.from('Signed body').toString('base64'),
      });
      expectAllowed(bin, 'integration creates note Binary');
      const s = await signNote(integration, await writeDraftNote(integration, `Patient/${fx.a.patient.id}`, pRef), pRef, {
        noteContentUrl: `Binary/${bin.body.id}`,
      });
      const addBin = await integration.create({
        resourceType: 'Binary',
        contentType: 'text/plain',
        data: Buffer.from('Addendum body').toString('base64'),
      });
      const add = await integration.create(
        addendum(s, pRef, { content: [{ attachment: { contentType: 'text/plain', url: `Binary/${addBin.body.id}` } }] })
      );
      expectAllowed(add, 'addendum with Binary content');
      const noPolicyClient = await fx.superAdmin.request('POST', `admin/projects/${fx.a.projectId}/client`, {
        name: `no-policy-bin-${fx.a.run}`,
      });
      const client = new Actor('no-policy-client', await clientLogin(noPolicyClient.body.id, noPolicyClient.body.secret));
      for (const a of [admin, client]) {
        for (const id of [bin.body.id, addBin.body.id]) {
          const raw = await fetch(`${BASE_URL}fhir/R4/Binary/${id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${a.client.getAccessToken()}`, 'Content-Type': 'text/plain' },
            body: 'FORGED SIGNED NOTE BODY - injected by admin',
          });
          expectLockDenied(
            { status: raw.status, body: await raw.json() },
            SIGNED_LOCK_REASONS.binaryImmutable,
            `${a.name} raw PUT Binary`
          );
          expectLockDenied(
            await a.update({ resourceType: 'Binary', id, contentType: 'text/plain', data: 'Rk9SR0VE' } as any),
            SIGNED_LOCK_REASONS.binaryImmutable,
            `${a.name} FHIR PUT Binary`
          );
          expectLockDenied(await a.delete(`Binary/${id}`), SIGNED_LOCK_REASONS.binaryImmutable, `${a.name} DELETE Binary`);
          expectLockDenied(
            await a.get(`Binary/${id}/$presigned-url?upload=true`),
            SIGNED_LOCK_REASONS.binaryImmutable,
            `${a.name} presigned upload URL`
          );
        }
      }
      const body = await fetch(`${BASE_URL}fhir/R4/Binary/${bin.body.id}`, {
        headers: { Authorization: `Bearer ${fx.superAdmin.client.getAccessToken()}`, Accept: 'text/plain' },
      });
      expect(await body.text()).toBe('Signed body');
      const current = await fx.superAdmin.get(`Binary/${bin.body.id}`);
      expect(current.body.meta.versionId).toBe((bin.body as any).meta?.versionId);
      const hist = await fx.superAdmin.get(`DocumentReference/${s.noteDocument.id}/_history`);
      expect(hist.body.entry).toHaveLength(1);
    });

    test('CLOSED: the same admin cannot edit signed content or attach children by identifier', async () => {
      const s = await sign();
      expectLockDenied(
        await admin.update<Encounter>({ ...s.encounter, status: 'in-progress' }),
        SIGNED_LOCK_REASONS.signedContent,
        'policy-less admin reverts encounter'
      );
      expectLockDenied(
        await admin.create({
          resourceType: 'Procedure',
          status: 'completed',
          code: { text: 'x' },
          subject: { reference: `Patient/${fx.a.patient.id}` },
          encounter: { type: 'Encounter', identifier: { system: 'x', value: s.encounter.id } },
        } as any),
        SIGNED_LOCK_REASONS.encounterReferenceInvalid,
        'policy-less admin identifier-only Procedure'
      );
    });
  });

  describe('contrast: a project WITHOUT the flag keeps upstream behaviour', () => {
    test('a policy-less client can revert a finished encounter', async () => {
      const created = await fx.superAdmin.create<Project>({
        resourceType: 'Project',
        name: `practiceai-test-unflagged-${fx.a.run}`,
        features: ['transaction-bundles'],
      });
      expectStatus(created, 201, 'create unflagged project');
      const raw = await fx.superAdmin.request('POST', `admin/projects/${created.body.id}/client`, {
        name: `no-policy-unflagged-${fx.a.run}`,
      });
      expectStatus(raw, 201, 'client without policy');
      const c = new Actor('no-policy-unflagged', await clientLogin(raw.body.id, raw.body.secret));
      const enc = await c.create<Encounter>({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' } });
      expectStatus(enc, 201, 'create finished encounter');
      expectStatus(await c.update<Encounter>({ ...enc.body, status: 'in-progress' }), 200, 'revert finished encounter');
    });
  });
});
