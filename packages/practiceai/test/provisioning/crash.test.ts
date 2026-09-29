/**
 * Provisioning must converge after a crash at ANY point (adversarial review).
 *
 * The fake admin client is wrapped so that the N-th write throws (the process "dies" there). A second,
 * normal run must then finish the job with no duplicates, and a third run must make zero writes.
 */
import type { Project, ProjectMembership } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { REQUIRED_PROJECT_FEATURES, SIGNED_LOCK_PROJECT_SETTING } from '../../src/policies';
import { INTEGRATION_CLIENT_NAME, npiWithCheckDigit, provisionPractice } from '../../src/provisioning';
import type { ProvisionPracticeInput } from '../../src/provisioning';
import type { AdminClient } from '../../src/provisioning/types';
import { FakeAdmin } from './fake-admin';

const INPUT: ProvisionPracticeInput = {
  practiceName: 'Synthetic Crash Clinic',
  organizationId: '6f1c1f39-2f0a-4c55-9d1e-3f7c0c8a0b01',
  adminEmail: 'admin@synthetic-crash.example',
  providers: [
    { npi: npiWithCheckDigit('111222333'), firstName: 'Pat', lastName: 'Synthetic', email: 'pat@synthetic-crash.example' },
    { npi: npiWithCheckDigit('444555666'), firstName: 'Sam', lastName: 'Fictional' },
  ],
};

const WRITE_METHODS = new Set(['createResource', 'createResourceIfNoneExist', 'updateResource', 'post']);

class Crash extends Error {}

/** Wraps an AdminClient so that the write with index `crashAt` (0-based) throws before reaching the store. */
function crashing(client: AdminClient, crashAt: number, counter = { writes: 0 }): AdminClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && WRITE_METHODS.has(prop) && typeof value === 'function') {
        return (...args: unknown[]) => {
          if (counter.writes++ === crashAt) throw new Crash(`simulated crash at write #${crashAt} (${prop})`);
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
}

function census(fake: FakeAdmin): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of fake.store.values()) out[r.resourceType] = (out[r.resourceType] ?? 0) + 1;
  return out;
}

describe('provisioning survives a crash at every write', () => {
  const clean = new FakeAdmin();
  let baseline: Record<string, number> = {};
  let totalWrites = 0;

  test('baseline: a clean run, then a no-op rerun', async () => {
    const counter = { writes: 0 };
    await provisionPractice(crashing(clean.client(), -1, counter), INPUT);
    totalWrites = counter.writes; // client-level write calls
    const stored = clean.writes;
    baseline = census(clean);
    await provisionPractice(clean.client(), INPUT);
    expect(clean.writes).toBe(stored);
    expect(totalWrites).toBeGreaterThan(15);
    const project = clean.all('Project')[0] as Project;
    expect(project.features).toEqual(expect.arrayContaining([...REQUIRED_PROJECT_FEATURES]));
  });

  test('crash at write #N, rerun: same resources as a clean run, and the next run is a no-op', async () => {
    for (let n = 0; n < totalWrites; n++) {
      const fake = new FakeAdmin();
      await expect(provisionPractice(crashing(fake.client(), n), INPUT)).rejects.toBeInstanceOf(Crash);
      const recovered = await provisionPractice(fake.client(), INPUT);
      expect(census(fake), `crash at write #${n}`).toEqual(baseline);
      const settled = fake.writes;
      await provisionPractice(fake.client(), INPUT);
      expect(fake.writes, `no-op after recovery (crash at #${n})`).toBe(settled);
      expect(recovered.projectId).toBeTruthy();
      expect(recovered.integration.clientId).toBeTruthy();
    }
  });

  test('a ClientApplication left without a membership (non-atomic server endpoint) is repaired with a fresh secret', async () => {
    const fake = new FakeAdmin();
    const first = await provisionPractice(fake.client(), INPUT);
    const clientId = first.integration.clientId as string;
    const oldSecret = first.integration.clientSecret?.reveal();
    const membership = fake
      .all('ProjectMembership')
      .find((m) => (m as ProjectMembership).user?.reference === `ClientApplication/${clientId}`);
    expect(membership).toBeDefined();
    fake.store.delete(`ProjectMembership/${membership?.id}`);

    const repaired = await provisionPractice(fake.client(), INPUT);
    expect(repaired.integration.clientId).toBe(clientId);
    const newSecret = repaired.integration.clientSecret?.reveal();
    expect(newSecret).toBeTruthy();
    expect(newSecret).not.toBe(oldSecret);
    expect(repaired.actions.find((a) => a.step === 'integration-client:membership')?.status).toBe('created');
    // exactly one membership again, bound to the integration policy, not admin
    const ms = fake
      .all('ProjectMembership')
      .filter((m) => (m as ProjectMembership).user?.reference === `ClientApplication/${clientId}`) as ProjectMembership[];
    expect(ms).toHaveLength(1);
    expect(ms[0]?.accessPolicy?.reference).toBe(`AccessPolicy/${repaired.accessPolicies.integration}`);
    expect(ms[0]?.admin).toBeFalsy();
    // JSON output of the result never carries the secret
    expect(JSON.stringify(repaired)).not.toContain(newSecret as string);
    expect(fake.all('ClientApplication').filter((c) => (c as { name?: string }).name === INTEGRATION_CLIENT_NAME)).toHaveLength(1);
  });

  test('an existing project without transaction-bundles is repaired; other features are kept', async () => {
    const fake = new FakeAdmin();
    await provisionPractice(fake.client(), INPUT);
    const project = fake.all('Project')[0] as Project & { id: string };
    fake.store.set(`Project/${project.id}`, { ...project, features: ['bots'] } as never);
    const r = await provisionPractice(fake.client(), INPUT);
    expect(r.actions.find((a) => a.step === 'project')?.status).toBe('updated');
    expect((fake.all('Project')[0] as Project).features).toEqual(['bots', ...REQUIRED_PROJECT_FEATURES]);
  });

  test('an existing project without (or with a cleared) signed-lock flag is repaired; other settings kept', async () => {
    const fake = new FakeAdmin();
    await provisionPractice(fake.client(), INPUT);
    const project = fake.all('Project')[0] as Project & { id: string };
    expect(project.systemSetting).toEqual([{ name: SIGNED_LOCK_PROJECT_SETTING, valueBoolean: true }]);
    const other = { name: 'rateLimit', valueInteger: 100 };
    for (const systemSetting of [undefined, [other], [other, { name: SIGNED_LOCK_PROJECT_SETTING, valueBoolean: false }]]) {
      fake.store.set(`Project/${project.id}`, { ...project, systemSetting } as never);
      const r = await provisionPractice(fake.client(), INPUT);
      expect(r.actions.find((a) => a.step === 'project')?.status).toBe('updated');
      const repaired = (fake.all('Project')[0] as Project).systemSetting;
      expect(repaired).toContainEqual({ name: SIGNED_LOCK_PROJECT_SETTING, valueBoolean: true });
      if (systemSetting) {
        expect(repaired).toContainEqual(other);
      }
      const again = await provisionPractice(fake.client(), INPUT);
      expect(again.actions.find((a) => a.step === 'project')?.status).toBe('unchanged');
    }
  });
});
