import type { AccessPolicy, ProjectMembership } from '@medplum/fhirtypes';
import { inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import { PROVISIONING_SYSTEMS, SYSTEMS, ptContentResources } from '../../src/content';
import { parseProviderSpec } from '../../src/cli';
import { PRACTICE_ROLES } from '../../src/policies';
import {
  AI_SERVICE_CLIENT_NAME,
  INTEGRATION_CLIENT_NAME,
  OneTimeSecret,
  ProvisioningError,
  ProvisioningInputError,
  SECRET_NOT_REISSUED,
  buildPracticeOrganization,
  buildProject,
  buildProviderPractitioner,
  canonical,
  isValidNpi,
  mergeIdentifiers,
  mergeMedplumProjects,
  normalizeProvisionInput,
  npiWithCheckDigit,
  provisionPractice,
  toMedplumProjects,
} from '../../src/provisioning';
import type { ProvisionPracticeInput } from '../../src/provisioning';
import { FakeAdmin } from './fake-admin';

const ORG = '3b0f6f0e-8a57-4a39-9a55-2f2d8d5d0c11';
const NPI_A = npiWithCheckDigit('123456789');
const NPI_B = npiWithCheckDigit('987654321');

function input(overrides: Partial<ProvisionPracticeInput> = {}): ProvisionPracticeInput {
  return {
    practiceName: 'Synthetic PT Clinic',
    organizationId: ORG,
    adminEmail: 'Admin@Synthetic-PT.example',
    providers: [
      { npi: NPI_A, firstName: 'Pat', lastName: 'Synthetic', email: 'pat@synthetic-pt.example', suffix: 'DPT' },
      { npi: NPI_B, firstName: 'Sam', lastName: 'Fictional' },
    ],
    ...overrides,
  };
}

/** Billing app config.ts medplumProjectsSchema, re-expressed without zod. */
function assertBillingShape(map: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(map)) {
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const v = value as Record<string, unknown>;
    expect(Object.keys(v).sort()).toEqual(['baseUrl', 'clientId', 'clientSecret', 'projectId']);
    for (const k of ['projectId', 'clientId', 'clientSecret'] as const) expect(typeof v[k] === 'string' && (v[k] as string).length > 0).toBe(true);
    expect(() => new URL(v.baseUrl as string)).not.toThrow();
  }
}

describe('input validation', () => {
  test('NPI check digit', () => {
    expect(isValidNpi('1234567893')).toBe(true);
    expect(isValidNpi('1234567890')).toBe(false);
    expect(isValidNpi('123456789')).toBe(false);
    expect(isValidNpi(npiWithCheckDigit('192837465'))).toBe(true);
  });

  test('normalizes e-mail, uuid and defaults', () => {
    const n = normalizeProvisionInput(input({ organizationId: ORG.toUpperCase() }));
    expect(n.organizationId).toBe(ORG);
    expect(n.adminEmail).toBe('admin@synthetic-pt.example');
    expect(n.adminFirstName).toBe('Practice');
    expect(n.providers?.[0]?.email).toBe('pat@synthetic-pt.example');
  });

  test('reports every problem', () => {
    try {
      normalizeProvisionInput({
        practiceName: ' ',
        organizationId: 'not-a-uuid',
        adminEmail: 'nope',
        providers: [
          { npi: '1234567890', firstName: '', lastName: 'X' },
          { npi: NPI_A, firstName: 'A', lastName: 'B', email: 'admin@x.example' },
          { npi: NPI_A, firstName: 'A', lastName: 'B', email: 'admin@x.example' },
        ],
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProvisioningInputError);
      const problems = (err as ProvisioningInputError).problems.join('\n');
      for (const p of ['practiceName', 'organizationId', 'adminEmail', 'providers[0].npi', 'providers[0] needs', 'providers[2].npi is duplicated', 'providers[2].email duplicates']) {
        expect(problems).toContain(p);
      }
    }
  });

  test('provider e-mail equal to the admin e-mail is rejected (one membership per user)', () => {
    expect(() => normalizeProvisionInput(input({ providers: [{ npi: NPI_A, firstName: 'A', lastName: 'B', email: 'ADMIN@synthetic-pt.example' }] }))).toThrow(
      /duplicates another user/,
    );
  });

  test('parseProviderSpec', () => {
    expect(parseProviderSpec(`npi=${NPI_A},first=Pat,last=Synthetic,email=pat@x.example,suffix=DPT`)).toEqual({
      npi: NPI_A,
      firstName: 'Pat',
      lastName: 'Synthetic',
      email: 'pat@x.example',
      suffix: 'DPT',
    });
    expect(() => parseProviderSpec('npi=1')).toThrow(ProvisioningInputError);
  });
});

describe('builders', () => {
  const n = normalizeProvisionInput(input({ groupNpi: NPI_B }));

  test('project carries the billing organization id and strict mode', () => {
    const p = buildProject(n);
    expect(p.identifier).toEqual([{ system: PROVISIONING_SYSTEMS.organizationId, value: ORG }]);
    expect(p.strictMode).toBe(true);
    expect(p.name).toBe('Synthetic PT Clinic');
  });

  test('organization lives in the project and carries org id + group NPI', () => {
    const o = buildPracticeOrganization(n, 'proj-1');
    expect(o.meta?.project).toBe('proj-1');
    expect(o.identifier).toContainEqual({ system: PROVISIONING_SYSTEMS.organizationId, value: ORG });
    expect(o.identifier).toContainEqual({ system: SYSTEMS.npi, value: NPI_B });
  });

  test('practitioner has the NPI identifier in the billing app system', () => {
    const p = buildProviderPractitioner(n.providers?.[0] as NonNullable<typeof n.providers>[number], 'proj-1');
    expect(p.identifier).toEqual([{ system: 'http://hl7.org/fhir/sid/us-npi', value: NPI_A }]);
    expect(p.name?.[0]).toMatchObject({ given: ['Pat'], family: 'Synthetic', suffix: ['DPT'] });
    expect(p.meta?.project).toBe('proj-1');
  });

  test('mergeIdentifiers keeps existing and adds missing', () => {
    expect(mergeIdentifiers([{ system: 'a', value: '1' }], [{ system: 'a', value: '1' }, { system: 'b', value: '2' }])).toEqual([
      { system: 'a', value: '1' },
      { system: 'b', value: '2' },
    ]);
  });

  test('canonical is key-order independent', () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe('one-time secret', () => {
  test('never serializes or prints its value', () => {
    const s = new OneTimeSecret('s3cr3t-value');
    expect(JSON.stringify({ s })).not.toContain('s3cr3t');
    expect(`${s}`).not.toContain('s3cr3t');
    expect(inspect({ s })).not.toContain('s3cr3t');
    expect(s.reveal()).toBe('s3cr3t-value');
  });
});

describe('provisionPractice (in-memory admin)', () => {
  test('creates the practice, binds policies, and loads content', async () => {
    const fake = new FakeAdmin();
    const r = await provisionPractice(fake.client(), input());
    expect(r.projectId).toBeTruthy();
    const project = fake.all('Project')[0];
    expect(project?.id).toBe(r.projectId);

    // Everything else lives in the practice project.
    for (const res of fake.store.values()) {
      if (res.resourceType !== 'Project') expect(res.meta?.project).toBe(r.projectId);
    }

    // One policy per role; clients and users bound to the right one.
    expect(Object.keys(r.accessPolicies).sort()).toEqual([...PRACTICE_ROLES].sort());
    const policyOf = (m: ProjectMembership | undefined) => (fake.store.get(m?.accessPolicy?.reference ?? '') as AccessPolicy | undefined)?.id;
    const membership = (q: Record<string, string>) => fake.search('ProjectMembership', q)[0] as ProjectMembership | undefined;
    expect(policyOf(membership({ user: `ClientApplication/${r.integration.clientId}` }))).toBe(r.accessPolicies.integration);
    expect(policyOf(membership({ user: `ClientApplication/${r.aiService.clientId}` }))).toBe(r.accessPolicies.ai_service);
    const adminMembership = membership({ profile: `Practitioner/${r.admin.practitionerId}` });
    expect(policyOf(adminMembership)).toBe(r.accessPolicies.practice_admin);
    expect(adminMembership?.admin).toBe(false);
    expect(policyOf(membership({ profile: `Practitioner/${r.providers[0]?.practitionerId}` }))).toBe(r.accessPolicies.provider);
    // Provider without e-mail: Practitioner only, no membership.
    expect(r.providers[1]?.practitionerId).toBeTruthy();
    expect(r.providers[1]?.membershipId).toBeNull();

    const names = fake.all('ClientApplication').map((c) => (c as { name?: string }).name);
    expect(names.sort()).toEqual([AI_SERVICE_CLIENT_NAME, INTEGRATION_CLIENT_NAME].sort());
    expect(r.content.map((c) => c.url)).toEqual(ptContentResources().map((c) => c.url));

    // Secret: returned once, never in actions / JSON.
    const secret = r.integration.clientSecret?.reveal() as string;
    expect(secret).toBe((fake.store.get(`ClientApplication/${r.integration.clientId}`) as { secret?: string }).secret);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(inspect(r, { depth: 10 })).not.toContain(secret);

    const map = toMedplumProjects(r, { revealSecret: true });
    assertBillingShape(map);
    expect(map[ORG]).toEqual({ projectId: r.projectId, clientId: r.integration.clientId, clientSecret: secret, baseUrl: 'http://fake-medplum.local/' });
    expect(JSON.stringify(toMedplumProjects(r))).not.toContain(secret);
  });

  test('re-running converges: same ids, no writes, no new secret', async () => {
    const fake = new FakeAdmin();
    const first = await provisionPractice(fake.client(), input());
    const writes = fake.writes;
    const second = await provisionPractice(fake.client(), input());
    expect(fake.writes).toBe(writes);
    expect(second.actions.every((a) => a.status === 'unchanged')).toBe(true);
    for (const key of ['projectId', 'practiceOrganizationId', 'accessPolicies', 'aiService', 'admin', 'providers', 'content'] as const) {
      expect(second[key]).toEqual(first[key]);
    }
    expect(second.integration.clientId).toBe(first.integration.clientId);
    expect(second.integration.clientSecret).toBeNull();
    const map = toMedplumProjects(second);
    expect(map[ORG]?.clientSecret).toBe(SECRET_NOT_REISSUED);
    // Merging into the existing env keeps the originally issued secret.
    const merged = mergeMedplumProjects(JSON.stringify(toMedplumProjects(first, { revealSecret: true })), map);
    expect(merged[ORG]?.clientSecret).toBe(first.integration.clientSecret?.reveal());
  });

  test('re-running repairs drift (policy content, membership binding, renamed practice)', async () => {
    const fake = new FakeAdmin();
    const first = await provisionPractice(fake.client(), input());
    const policy = fake.store.get(`AccessPolicy/${first.accessPolicies.biller}`) as AccessPolicy & { id: string };
    fake.store.set(`AccessPolicy/${policy.id}`, { ...policy, resource: [{ resourceType: '*' }] } as AccessPolicy & { id: string });
    const m = fake.search('ProjectMembership', { user: `ClientApplication/${first.integration.clientId}` })[0] as ProjectMembership & { id: string };
    fake.store.set(`ProjectMembership/${m.id}`, { ...m, accessPolicy: { reference: `AccessPolicy/${first.accessPolicies.biller}` } });

    const second = await provisionPractice(fake.client(), input({ practiceName: 'Synthetic PT Clinic (renamed)' }));
    const updated = second.actions.filter((a) => a.status === 'updated').map((a) => a.step);
    expect(updated).toEqual(expect.arrayContaining(['project', 'organization', 'access-policy:biller', 'integration-client:membership']));
    expect((fake.store.get(`AccessPolicy/${policy.id}`) as AccessPolicy).resource).not.toContainEqual({ resourceType: '*' });
    expect((fake.search('ProjectMembership', { user: `ClientApplication/${first.integration.clientId}` })[0] as ProjectMembership | undefined)?.accessPolicy?.reference).toBe(
      `AccessPolicy/${first.accessPolicies.integration}`,
    );
    expect(second.projectId).toBe(first.projectId);
  });

  test('rotation issues a new secret and keeps the old one as retiringSecret', async () => {
    const fake = new FakeAdmin();
    const first = await provisionPractice(fake.client(), input());
    const rotated = await provisionPractice(fake.client(), input(), { rotateIntegrationSecret: true });
    const client = fake.store.get(`ClientApplication/${first.integration.clientId}`) as { secret?: string; retiringSecret?: string };
    expect(rotated.integration.clientSecret?.reveal()).toBe(client.secret);
    expect(client.retiringSecret).toBe(first.integration.clientSecret?.reveal());
    expect(JSON.stringify(rotated.actions)).not.toContain(client.secret as string);
  });

  test('two practices get separate projects', async () => {
    const fake = new FakeAdmin();
    const a = await provisionPractice(fake.client(), input());
    const b = await provisionPractice(fake.client(), input({ organizationId: '9d7c7a9e-3a4b-4c55-8d66-777788889999', practiceName: 'Other Synthetic PT' }));
    expect(b.projectId).not.toBe(a.projectId);
    expect(b.integration.clientId).not.toBe(a.integration.clientId);
    expect(fake.search('Questionnaire', { _project: b.projectId as string })).toHaveLength(1);
    expect(fake.search('Questionnaire', { _project: a.projectId as string })).toHaveLength(1);
  });

  test('dry run writes nothing', async () => {
    const fake = new FakeAdmin();
    const dry = await provisionPractice(fake.client(), input(), { dryRun: true });
    expect(fake.writes).toBe(0);
    expect(dry.projectId).toBeNull();
    expect(dry.actions.every((a) => a.status === 'would-create')).toBe(true);
    expect(() => toMedplumProjects(dry)).toThrow();

    await provisionPractice(fake.client(), input());
    const writes = fake.writes;
    const dry2 = await provisionPractice(fake.client(), input({ practiceName: 'Renamed' }), { dryRun: true, rotateIntegrationSecret: true });
    expect(fake.writes).toBe(writes);
    expect(dry2.actions.find((a) => a.step === 'project')?.status).toBe('would-update');
    expect(dry2.actions.find((a) => a.step === 'integration-client:secret')?.status).toBe('would-update');
    expect(dry2.integration.clientSecret).toBeNull();
  });

  test('refuses non-super-admin credentials and ambiguous state', async () => {
    const fake = new FakeAdmin();
    fake.superAdmin = false;
    await expect(provisionPractice(fake.client(), input())).rejects.toThrow(ProvisioningError);

    const dup = new FakeAdmin();
    await provisionPractice(dup.client(), input());
    const project = dup.all('Project')[0];
    dup.store.set('Project/dup', { ...(project as NonNullable<typeof project>), id: 'dup' });
    await expect(provisionPractice(dup.client(), input())).rejects.toThrow(/resolve the duplicates/);
  });
});
