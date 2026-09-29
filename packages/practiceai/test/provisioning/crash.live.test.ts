/**
 * Provisioning against the REAL server survives a crash at any write, repairs a ClientApplication left
 * without a membership, turns on atomic transactions, and never writes a secret to the server log.
 * Skipped unless MEDPLUM_BASE_URL is set. Synthetic data only (fresh random organization ids per run).
 */
import type { MedplumClient } from '@medplum/core';
import type { Project, ProjectMembership, Resource, ResourceType } from '@medplum/fhirtypes';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { PROVISIONING_SYSTEMS } from '../../src/content';
import { REQUIRED_PROJECT_FEATURES } from '../../src/policies';
import { npiWithCheckDigit, provisionPractice, toMedplumProjects } from '../../src/provisioning';
import type { ProvisionPracticeInput, ProvisionResult } from '../../src/provisioning';
import { LIVE, clientLogin, statusOf, superAdminClient } from './live-helpers';

const RUN = randomUUID().slice(0, 8);
const WRITE_METHODS = new Set(['createResource', 'createResourceIfNoneExist', 'updateResource', 'post']);
const SERVER_LOG = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.run', 'server.log');

class Crash extends Error {}

function crashing(client: MedplumClient, crashAt: number, counter = { writes: 0 }): MedplumClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && WRITE_METHODS.has(prop) && typeof value === 'function') {
        return (...args: unknown[]) => {
          if (counter.writes++ === crashAt) throw new Crash(`simulated crash at write #${crashAt} (${prop})`);
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function practice(label: string): ProvisionPracticeInput {
  return {
    practiceName: `PracticeAI crash test ${label} ${RUN}`,
    organizationId: randomUUID(),
    adminEmail: `admin-crash-${label}-${RUN}@synthetic-pt.example`,
    providers: [
      {
        npi: npiWithCheckDigit(String(100000000 + Math.floor(Math.random() * 8e8))),
        firstName: 'Pat',
        lastName: `Crash${label}`,
        email: `pat-crash-${label}-${RUN}@synthetic-pt.example`,
      },
    ],
  };
}

async function count(admin: MedplumClient, type: ResourceType, query: Record<string, string>): Promise<number> {
  const found = await admin.searchResources(type, { ...query, _count: '50' }, { cache: 'no-cache' });
  return found.length;
}

/** Everything provisioning owns, counted by the stable keys it uses. */
async function census(admin: MedplumClient, input: ProvisionPracticeInput, projectId: string): Promise<Record<string, number>> {
  const inProject = { _project: projectId };
  return {
    Project: await count(admin, 'Project', { identifier: `${PROVISIONING_SYSTEMS.organizationId}|${input.organizationId}` }),
    Organization: await count(admin, 'Organization', { identifier: `${PROVISIONING_SYSTEMS.organizationId}|${input.organizationId}`, ...inProject }),
    AccessPolicy: await count(admin, 'AccessPolicy', inProject),
    ClientApplication: await count(admin, 'ClientApplication', inProject),
    ProjectMembership: await count(admin, 'ProjectMembership', { project: `Project/${projectId}` }),
    Practitioner: await count(admin, 'Practitioner', inProject),
    Questionnaire: await count(admin, 'Questionnaire', inProject),
    ValueSet: await count(admin, 'ValueSet', inProject),
    CodeSystem: await count(admin, 'CodeSystem', inProject),
  };
}

describe.skipIf(!LIVE)('provisioning crash safety (live server)', () => {
  let admin: MedplumClient;
  let totalWrites = 0;
  let baseline: Record<string, number>;

  beforeAll(async () => {
    admin = await superAdminClient();
    const input = practice('baseline');
    const counter = { writes: 0 };
    const r = await provisionPractice(crashing(admin, -1, counter), input);
    totalWrites = counter.writes;
    baseline = await census(admin, input, r.projectId as string);
  }, 120_000);

  test('a provisioned project has atomic transactions (transaction-bundles)', async () => {
    const input = practice('features');
    const r = await provisionPractice(admin, input);
    const project = await admin.readResource<Project>('Project', r.projectId as string);
    expect(project.features).toEqual(expect.arrayContaining([...REQUIRED_PROJECT_FEATURES]));
    // drift repair: a super admin removing the feature is undone by the next run
    await admin.updateResource<Project>({ ...project, features: [] });
    const again = await provisionPractice(admin, input);
    expect(again.actions.find((a) => a.step === 'project')?.status).toBe('updated');
    expect((await admin.readResource<Project>('Project', r.projectId as string)).features).toEqual([...REQUIRED_PROJECT_FEATURES]);
  });

  test('crash at every write #N, then rerun: converges to the same resources with no duplicates; a third run is a no-op', async () => {
    expect(totalWrites).toBeGreaterThan(15);
    expect(baseline).toMatchObject({ Project: 1, Organization: 1, AccessPolicy: 7, ClientApplication: 2 });
    for (let n = 0; n < totalWrites; n++) {
      const input = practice(`n${n}`);
      await expect(provisionPractice(crashing(admin, n), input), `crash at #${n}`).rejects.toBeInstanceOf(Crash);
      const recovered = await provisionPractice(admin, input);
      expect(await census(admin, input, recovered.projectId as string), `census after crash at #${n}`).toEqual(baseline);
      const third = await provisionPractice(admin, input);
      expect(third.actions.filter((a) => a.status !== 'unchanged'), `no-op after crash at #${n}`).toEqual([]);
      expect(third.projectId).toBe(recovered.projectId);
    }
  }, 600_000);

  test('a ClientApplication without a membership is repaired: new secret works, the undelivered one does not', async () => {
    const input = practice('repair');
    const first = await provisionPractice(admin, input);
    const clientId = first.integration.clientId as string;
    const oldSecret = first.integration.clientSecret?.reveal() as string;
    const [membership] = await admin.searchResources<ProjectMembership>(
      'ProjectMembership',
      { project: `Project/${first.projectId}`, user: `ClientApplication/${clientId}` },
      { cache: 'no-cache' }
    );
    expect(membership).toBeDefined();
    await admin.deleteResource('ProjectMembership', membership?.id as string);

    const repaired = await provisionPractice(admin, input);
    expect(repaired.integration.clientId).toBe(clientId);
    const newSecret = repaired.integration.clientSecret?.reveal() as string;
    expect(newSecret).toBeTruthy();
    expect(newSecret).not.toBe(oldSecret);
    const entry = toMedplumProjects(repaired, { revealSecret: true })[input.organizationId];
    const client = await clientLogin(clientId, entry?.clientSecret as string);
    expect(client.getActiveLogin()?.project.reference).toBe(`Project/${first.projectId}`);
    expect(await statusOf(clientLogin(clientId, oldSecret))).not.toBe(0);
    // redacted everywhere except the explicit reveal
    expect(JSON.stringify(repaired)).not.toContain(newSecret);
    expect(String(repaired.integration.clientSecret)).not.toContain(newSecret);
    const ms = await admin.searchResources<ProjectMembership>('ProjectMembership', { project: `Project/${first.projectId}`, user: `ClientApplication/${clientId}` }, { cache: 'no-cache' });
    expect(ms).toHaveLength(1);
    expect(ms[0]?.accessPolicy?.reference).toBe(`AccessPolicy/${repaired.accessPolicies.integration}`);
    expect(ms[0]?.admin).not.toBe(true);

    // The dev server log (scripts/dev-up.sh) never contains an issued secret.
    if (existsSync(SERVER_LOG)) {
      const log = readFileSync(SERVER_LOG, 'utf8');
      for (const s of [oldSecret, newSecret]) expect(log.includes(s)).toBe(false);
    }
  });

  test('provisioning output never carries the AI service secret and progress actions never carry secrets', async () => {
    const actions: string[] = [];
    const r: ProvisionResult = await provisionPractice(admin, practice('actions'), { onAction: (a) => actions.push(JSON.stringify(a)) });
    const secret = r.integration.clientSecret?.reveal() as string;
    expect(actions.join('\n')).not.toContain(secret);
    const ai = await admin.readResource<Resource & { secret?: string }>('ClientApplication', r.aiService.clientId as string);
    expect(JSON.stringify(r)).not.toContain(ai.secret as string);
    expect(actions.join('\n')).not.toContain(ai.secret as string);
  });
});
