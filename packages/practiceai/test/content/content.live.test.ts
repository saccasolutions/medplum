/**
 * Live content tests (skipped unless MEDPLUM_BASE_URL is set): the PT Questionnaire, ValueSets and
 * CodeSystem are accepted by the real server (strict-mode validation), loaded once per practice
 * project (conditional create by url + version), and readable by the practice's integration client.
 */
import type { MedplumClient } from '@medplum/core';
import type { Questionnaire, ResourceType, ValueSet } from '@medplum/fhirtypes';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import { CONTENT_URLS, PT_SOAP_QUESTIONNAIRE_URL, SOAP_LINK_IDS, ptContentResources } from '../../src/content';
import { provisionPractice, toMedplumProjects } from '../../src/provisioning';
import type { ProvisionResult } from '../../src/provisioning';
import { LIVE, clientLogin, superAdminClient } from '../provisioning/live-helpers';

describe.skipIf(!LIVE)('PT content (live server)', () => {
  let admin: MedplumClient;
  let result: ProvisionResult;
  let other: ProvisionResult;
  let integration: MedplumClient;

  beforeAll(async () => {
    admin = await superAdminClient();
    const run = randomUUID().slice(0, 8);
    const base = { adminEmail: `content-admin-${run}@synthetic-pt.example`, providers: [] };
    result = await provisionPractice(admin, { ...base, practiceName: `PracticeAI content test ${run}`, organizationId: randomUUID() });
    other = await provisionPractice(admin, {
      ...base,
      adminEmail: `content-admin2-${run}@synthetic-pt.example`,
      practiceName: `PracticeAI content test 2 ${run}`,
      organizationId: randomUUID(),
    });
    const e = toMedplumProjects(result, { revealSecret: true })[result.organizationId];
    integration = await clientLogin(e?.clientId as string, e?.clientSecret as string);
  }, 180_000);

  test('every content resource exists exactly once in each practice project', async () => {
    for (const r of ptContentResources()) {
      for (const p of [result, other]) {
        const found = await admin.searchResources(r.resourceType as ResourceType, { url: r.url, version: r.version, _project: p.projectId as string }, { cache: 'no-cache' });
        expect(found.length, `${r.resourceType} ${r.url} in ${p.projectId}`).toBe(1);
        expect(found[0]?.meta?.project).toBe(p.projectId);
      }
    }
    expect(result.content.every((c) => c.reference !== null)).toBe(true);
  });

  test('reloading content is a no-op (conditional create by url + version)', async () => {
    const again = await provisionPractice(admin, {
      practiceName: (await admin.readResource('Project', result.projectId as string)).name as string,
      organizationId: result.organizationId,
      adminEmail: result.admin.email,
      providers: [],
    });
    expect(again.content).toEqual(result.content);
    expect(again.actions.filter((a) => a.step.startsWith('content:')).every((a) => a.status === 'unchanged')).toBe(true);
  });

  test('integration client reads the questionnaire referenced by QuestionnaireResponse.questionnaire', async () => {
    const qs = await integration.searchResources('Questionnaire', { url: PT_SOAP_QUESTIONNAIRE_URL, version: '1' });
    expect(qs.length).toBe(1);
    const q = qs[0] as Questionnaire;
    expect(q.meta?.project ?? result.projectId).toBe(result.projectId);
    for (const linkId of SOAP_LINK_IDS) expect(q.item?.find((i) => i.linkId === linkId)?.type).toBe('text');
    const cpt = await integration.searchResources('ValueSet', { url: CONTENT_URLS.ptProcedureValueSet });
    expect(cpt.length).toBe(1);
    expect((cpt[0] as ValueSet).compose?.include.flatMap((i) => i.concept ?? []).map((c) => c.code)).toContain('97110');
    const icd = await integration.searchResources('ValueSet', { url: CONTENT_URLS.ptIcd10ValueSet });
    expect(icd.length).toBe(1);
    const cs = await integration.searchResources('CodeSystem', { url: CONTENT_URLS.ptVisitTypeCodeSystem });
    expect(cs.map((c) => c.concept?.map((x) => x.code))).toEqual([['eval', 're-eval', 'daily']]);
  });
});
