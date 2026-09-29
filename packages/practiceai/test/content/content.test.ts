import type { Questionnaire, QuestionnaireItem, ValueSet } from '@medplum/fhirtypes';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CONTENT_URLS,
  EXT,
  PLATFORM_FHIR_BASE,
  PT_COMMON_ICD10,
  PT_PROCEDURE_CODES,
  PT_SOAP_QUESTIONNAIRE,
  SOAP_LINK_IDS,
  SYSTEMS,
  buildPtIcd10ValueSet,
  buildPtProcedureValueSet,
  buildPtSoapQuestionnaire,
  buildPtVisitTypeCodeSystem,
  buildPtVisitTypeValueSet,
  ptContentResources,
} from '../../src/content';

const BILLING = process.env.PRACTICEAI_BILLING_DIR ?? '/home/user/billing';
const billingFile = (rel: string): string | null => {
  const path = `${BILLING}/${rel}`;
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

function allItems(items: QuestionnaireItem[] | undefined): QuestionnaireItem[] {
  return (items ?? []).flatMap((i) => [i, ...allItems(i.item)]);
}

describe('questionnaire', () => {
  const q = buildPtSoapQuestionnaire();

  test('canonical matches the billing app reference', () => {
    expect(`${q.url}|${q.version}`).toBe(PT_SOAP_QUESTIONNAIRE);
    expect(PT_SOAP_QUESTIONNAIRE).toBe('https://practiceai.example/fhir/Questionnaire/pt-soap-note|1');
  });

  test('SOAP sections are top-level required text items with the billing linkIds', () => {
    for (const linkId of SOAP_LINK_IDS) {
      const item = q.item?.find((i) => i.linkId === linkId);
      expect(item, linkId).toMatchObject({ type: 'text', required: true });
    }
  });

  test('a response shaped like the billing app output only answers known top-level text items', () => {
    // Shape produced by billing pt-note.ts soapItems().
    const qrItems = SOAP_LINK_IDS.map((linkId) => ({ linkId, answer: [{ valueString: 'synthetic' }] }));
    for (const qi of qrItems) {
      const def = q.item?.find((i) => i.linkId === qi.linkId);
      expect(def?.type).toBe('text');
    }
    // No other item is required, so the billing response is complete.
    const requiredOthers = allItems(q.item).filter((i) => i.required && !(SOAP_LINK_IDS as readonly string[]).includes(i.linkId));
    expect(requiredOthers).toEqual([]);
  });

  test('covers visit type, interventions (CPT + minutes), diagnoses, plan of care, authorization number', () => {
    const ids = allItems(q.item).map((i) => i.linkId);
    for (const id of [
      'visit.visitType',
      'visit.serviceDate',
      'interventions',
      'interventions.cpt',
      'interventions.minutes',
      'interventions.modifiers',
      'diagnoses',
      'diagnoses.icd10',
      'planOfCare.ref',
      'planOfCare.certificationStart',
      'authorization.number',
    ]) {
      expect(ids).toContain(id);
    }
    const byId = new Map(allItems(q.item).map((i) => [i.linkId, i]));
    expect(byId.get('visit.visitType')?.answerValueSet).toBe(CONTENT_URLS.ptVisitTypeValueSet);
    expect(byId.get('interventions.cpt')?.answerValueSet).toBe(CONTENT_URLS.ptProcedureValueSet);
    expect(byId.get('diagnoses.icd10')?.answerValueSet).toBe(CONTENT_URLS.ptIcd10ValueSet);
    expect(byId.get('interventions.minutes')?.definition).toBe(EXT.minutes);
    expect(byId.get('authorization.number')?.definition).toBe(`${EXT.authorization}#number`);
    expect(byId.get('planOfCare.ref')?.definition).toBe(EXT.planOfCare);
  });

  test('linkIds are unique; groups have children; enableWhen targets exist', () => {
    const items = allItems(q.item);
    const ids = items.map((i) => i.linkId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of items) {
      if (i.type === 'group') expect(i.item?.length, i.linkId).toBeGreaterThan(0);
      for (const ew of i.enableWhen ?? []) expect(ids).toContain(ew.question);
      if (i.answerValueSet || i.answerOption) expect(['choice', 'open-choice']).toContain(i.type);
    }
  });
});

describe('terminology', () => {
  test('visit type CodeSystem matches billing PtVisitType codes', () => {
    const cs = buildPtVisitTypeCodeSystem();
    expect(cs.url).toBe(SYSTEMS.ptVisitType);
    expect(cs.concept?.map((c) => c.code)).toEqual(['eval', 're-eval', 'daily']);
    expect(buildPtVisitTypeValueSet().compose?.include[0]?.system).toBe(SYSTEMS.ptVisitType);
  });

  test('procedure ValueSet: CPT and HCPCS systems, short platform labels, licensing note', () => {
    const vs: ValueSet = buildPtProcedureValueSet();
    const cpt = vs.compose?.include.find((i) => i.system === SYSTEMS.cpt);
    const hcpcs = vs.compose?.include.find((i) => i.system === SYSTEMS.hcpcs);
    expect(cpt?.concept?.length).toBe(PT_PROCEDURE_CODES.filter((c) => !c.hcpcs).length);
    expect(hcpcs?.concept?.map((c) => c.code)).toEqual(['G0283']);
    for (const c of [...(cpt?.concept ?? []), ...(hcpcs?.concept ?? [])]) {
      expect(c.display?.length ?? 0).toBeLessThanOrEqual(60);
      expect(c.extension?.find((e) => e.url === CONTENT_URLS.conceptTimed)?.valueBoolean).toBeTypeOf('boolean');
    }
    expect(vs.copyright).toMatch(/American Medical Association/);
    // We never define a CodeSystem for CPT itself.
    expect(ptContentResources().filter((r) => r.resourceType === 'CodeSystem').map((r) => r.url)).toEqual([SYSTEMS.ptVisitType]);
  });

  test('ICD-10 ValueSet: valid-looking ICD-10-CM codes, unique', () => {
    const vs = buildPtIcd10ValueSet();
    const codes = vs.compose?.include[0]?.concept?.map((c) => c.code) ?? [];
    expect(codes.length).toBe(PT_COMMON_ICD10.length);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-TV-Z]\d[0-9A-Z](\.[0-9A-Z]{1,4})?$/);
    expect(codes).toEqual(expect.arrayContaining(['M54.50', 'M62.81'])); // used by billing synthetic notes
  });

  test('content resources have unique url|version and load in dependency order', () => {
    const all = ptContentResources();
    const keys = all.map((r) => `${r.url}|${r.version}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(all.at(-1)?.resourceType).toBe('Questionnaire');
    for (const r of all) expect(r.url.startsWith(PLATFORM_FHIR_BASE)).toBe(true);
  });
});

describe('consistency with the billing app sources (skipped when the billing repo is absent)', () => {
  const constants = billingFile('src/lib/fhir/constants.ts');
  const catalog = billingFile('src/lib/fhir/pt-cpt.ts');

  test.skipIf(!constants)('platform base, systems and extension paths match billing constants.ts', () => {
    const src = constants as string;
    expect(src).toContain(`PLATFORM_FHIR_BASE = '${PLATFORM_FHIR_BASE}'`);
    for (const url of [SYSTEMS.npi, SYSTEMS.cpt, SYSTEMS.hcpcs, SYSTEMS.icd10cm, SYSTEMS.cptModifier, SYSTEMS.placeOfService, SYSTEMS.taxonomy]) {
      expect(src).toContain(`'${url}'`);
    }
    for (const url of Object.values(EXT)) {
      const suffix = url.replace(`${PLATFORM_FHIR_BASE}/StructureDefinition/`, '');
      expect(src).toContain(`\${SD}/${suffix}\``);
    }
    expect(src).toContain('`${CS}/pt-visit-type`');
    expect(src).toContain('`${PLATFORM_FHIR_BASE}/Questionnaire/pt-soap-note|1`');
  });

  test.skipIf(!catalog)('CPT/HCPCS codes and timed flags match billing pt-cpt.ts', () => {
    const src = catalog as string;
    const billing = [...src.matchAll(/entry\('([0-9A-Z]{5})', '[^']*', (true|false)/g)].map((m) => [m[1], m[2] === 'true']);
    expect(billing.length).toBeGreaterThan(0);
    expect(PT_PROCEDURE_CODES.map((c) => [c.code, c.timed])).toEqual(billing);
  });

  test('questionnaire type is Questionnaire', () => {
    const q: Questionnaire = buildPtSoapQuestionnaire();
    expect(q.resourceType).toBe('Questionnaire');
  });
});
