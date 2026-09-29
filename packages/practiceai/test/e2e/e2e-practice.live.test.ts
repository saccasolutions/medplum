// Live checks of scripts/provision-e2e.ts (the fixture used by the billing repo's
// tests/medplum-live suite and by the compose provisioning job). Skipped unless
// MEDPLUM_BASE_URL is set:
//
//   MEDPLUM_BASE_URL=http://localhost:8103/ npx vitest run test/e2e     (from packages/practiceai)
//
// Synthetic data only; each run provisions a new practice project.
import { ClientStorage, MedplumClient, MemoryStorage } from '@medplum/core';
import type { AccessPolicy, ProjectMembership } from '@medplum/fhirtypes';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import type { E2ePracticeFixture } from '../../scripts/provision-e2e';
import { E2E_PROVIDER, provisionE2ePractice } from '../../scripts/provision-e2e';

/** GET /auth/me: the membership (accessPolicy stripped) and the resolved policy (basedOn = the bound policies). */
interface Me {
  membership: ProjectMembership;
  accessPolicy?: AccessPolicy;
}

const BASE_URL = process.env.MEDPLUM_BASE_URL ? process.env.MEDPLUM_BASE_URL.replace(/\/?$/, '/') : undefined;

async function passwordLogin(email: string, password: string, projectId: string): Promise<MedplumClient> {
  const storage = new ClientStorage(new MemoryStorage());
  const verifier = randomBytes(48).toString('base64url');
  storage.setString('codeVerifier', verifier);
  const client = new MedplumClient({ baseUrl: BASE_URL, fetch, storage });
  const login = await client.startLogin({
    email,
    password,
    projectId,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    codeChallengeMethod: 'S256',
  });
  if (!login.code) {throw new Error('no code');}
  await client.processCode(login.code);
  return client;
}

describe.skipIf(!BASE_URL)('provision-e2e fixture (live server)', () => {
  let fixture: E2ePracticeFixture;

  beforeAll(async () => {
    fixture = await provisionE2ePractice({ baseUrl: BASE_URL as string, organizationId: randomUUID() });
  }, 120_000);

  test('MEDPLUM_PROJECTS entry logs in to the practice project only', async () => {
    const entry = fixture.MEDPLUM_PROJECTS[fixture.organizationId];
    expect(entry?.projectId).toBe(fixture.projectId);
    const client = new MedplumClient({ baseUrl: BASE_URL, fetch });
    await client.startClientLogin(String(entry?.clientId), String(entry?.clientSecret));
    expect(client.getActiveLogin()?.project.reference).toBe(`Project/${fixture.projectId}`);
  });

  test('provider and practice admin log in as non-admin members bound to their role policies', async () => {
    const provider = await passwordLogin(fixture.provider.email, fixture.provider.password, fixture.projectId);
    expect(provider.getActiveLogin()?.profile.reference).toBe(fixture.provider.practitionerRef);
    const pme = await provider.get<Me>(BASE_URL + 'auth/me');
    expect(pme.membership.admin ?? false).toBe(false);
    const providerPolicy = pme.accessPolicy?.basedOn?.[0]?.reference;
    expect(providerPolicy).toMatch(/^AccessPolicy\//);
    const practitioner = await provider.readReference({ reference: fixture.provider.practitionerRef });
    expect(practitioner.resourceType).toBe('Practitioner');
    expect((practitioner as { identifier?: { value?: string }[] }).identifier?.[0]?.value).toBe(E2E_PROVIDER.npi);

    const admin = await passwordLogin(fixture.admin.email, fixture.admin.password, fixture.projectId);
    expect(admin.getActiveLogin()?.profile.reference).toBe(fixture.admin.practitionerRef);
    const ame = await admin.get<Me>(BASE_URL + 'auth/me');
    expect(ame.membership.admin ?? false).toBe(false);
    const adminPolicy = ame.accessPolicy?.basedOn?.[0]?.reference;
    expect(adminPolicy).toMatch(/^AccessPolicy\//);
    expect(adminPolicy).not.toBe(providerPolicy);
    // The practice admin's Location is readable (read-only) by the billing integration client.
    expect(fixture.locationRef).toMatch(/^Location\//);
    const entry = fixture.MEDPLUM_PROJECTS[fixture.organizationId];
    const integration = new MedplumClient({ baseUrl: BASE_URL, fetch });
    await integration.startClientLogin(String(entry?.clientId), String(entry?.clientSecret));
    const location = await integration.readReference({ reference: fixture.locationRef });
    expect(location.resourceType).toBe('Location');
  });

  test('re-running keeps the project and the stored integration secret (no rotation)', async () => {
    const again = await provisionE2ePractice({ baseUrl: BASE_URL as string, organizationId: fixture.organizationId, previous: fixture });
    expect(again.projectId).toBe(fixture.projectId);
    expect(again.MEDPLUM_PROJECTS).toEqual(fixture.MEDPLUM_PROJECTS);
    expect(again.locationRef).toBe(fixture.locationRef);
  });

  test('re-running without the stored secret rotates it; the new secret logs in', async () => {
    const rotated = await provisionE2ePractice({ baseUrl: BASE_URL as string, organizationId: fixture.organizationId, previous: null });
    const entry = rotated.MEDPLUM_PROJECTS[fixture.organizationId];
    expect(rotated.projectId).toBe(fixture.projectId);
    expect(entry?.clientSecret).not.toBe(fixture.MEDPLUM_PROJECTS[fixture.organizationId]?.clientSecret);
    const client = new MedplumClient({ baseUrl: BASE_URL, fetch });
    await client.startClientLogin(String(entry?.clientId), String(entry?.clientSecret));
    expect(client.getActiveLogin()?.project.reference).toBe(`Project/${fixture.projectId}`);
  });
});
