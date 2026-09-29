/**
 * Terminology resources for PT documentation:
 *   - CodeSystem  pt-visit-type          (platform-owned codes: eval / re-eval / daily)
 *   - ValueSet    pt-visit-type
 *   - ValueSet    pt-procedure-codes     (CPT/HCPCS subset, platform-authored short labels)
 *   - ValueSet    pt-common-icd10        (PT-common ICD-10-CM starter list)
 *
 * The CPT subset is a ValueSet that *references* the AMA CPT system; it does
 * not define a CodeSystem for CPT (the platform does not own or redistribute
 * CPT). See README "Terminology licensing".
 */
import type { CodeSystem, ValueSet, ValueSetComposeIncludeConcept } from '@medplum/fhirtypes';
import { CONTENT_URLS, SYSTEMS } from './constants';
import { PT_COMMON_ICD10 } from './icd10';
import { PT_PROCEDURE_CODES, PT_VISIT_TYPES } from './pt-codes';

/** Version of the terminology content; bump when any code list changes. */
export const TERMINOLOGY_VERSION = '1';

const PUBLISHER = 'PracticeAI platform (synthetic/dev content)';
const DATE = '2026-09-29';

export function buildPtVisitTypeCodeSystem(): CodeSystem {
  return {
    resourceType: 'CodeSystem',
    url: CONTENT_URLS.ptVisitTypeCodeSystem,
    version: TERMINOLOGY_VERSION,
    name: 'PtVisitType',
    title: 'PT visit type',
    status: 'active',
    experimental: false,
    date: DATE,
    publisher: PUBLISHER,
    description: 'Physical therapy visit types used on Encounter.type by the PracticeAI platform.',
    caseSensitive: true,
    content: 'complete',
    count: PT_VISIT_TYPES.length,
    concept: PT_VISIT_TYPES.map((v) => ({ code: v.code, display: v.display, definition: v.definition })),
  };
}

export function buildPtVisitTypeValueSet(): ValueSet {
  return {
    resourceType: 'ValueSet',
    url: CONTENT_URLS.ptVisitTypeValueSet,
    version: TERMINOLOGY_VERSION,
    name: 'PtVisitTypes',
    title: 'PT visit types',
    status: 'active',
    experimental: false,
    date: DATE,
    publisher: PUBLISHER,
    description: 'All PT visit types.',
    compose: { include: [{ system: SYSTEMS.ptVisitType, version: TERMINOLOGY_VERSION }] },
  };
}

export function buildPtProcedureValueSet(): ValueSet {
  const concept = (c: (typeof PT_PROCEDURE_CODES)[number]): ValueSetComposeIncludeConcept => ({
    extension: [
      { url: CONTENT_URLS.conceptTimed, valueBoolean: c.timed },
      { url: CONTENT_URLS.conceptCategory, valueCode: c.category },
    ],
    code: c.code,
    display: c.label,
  });
  return {
    resourceType: 'ValueSet',
    url: CONTENT_URLS.ptProcedureValueSet,
    version: TERMINOLOGY_VERSION,
    name: 'PtProcedureCodes',
    title: 'PT procedure codes (CPT/HCPCS subset)',
    status: 'active',
    experimental: false,
    date: DATE,
    publisher: PUBLISHER,
    description:
      'Physical therapy CPT/HCPCS codes supported by the platform. Displays are short platform-authored labels, not AMA CPT descriptors.',
    copyright:
      'CPT codes are copyright American Medical Association; all rights reserved. This value set lists code values only, with platform-authored labels; CPT descriptors are not included. HCPCS Level II codes are published by CMS.',
    compose: {
      include: [
        { system: SYSTEMS.cpt, concept: PT_PROCEDURE_CODES.filter((c) => !c.hcpcs).map(concept) },
        { system: SYSTEMS.hcpcs, concept: PT_PROCEDURE_CODES.filter((c) => c.hcpcs).map(concept) },
      ],
    },
  };
}

export function buildPtIcd10ValueSet(): ValueSet {
  return {
    resourceType: 'ValueSet',
    url: CONTENT_URLS.ptIcd10ValueSet,
    version: TERMINOLOGY_VERSION,
    name: 'PtCommonIcd10',
    title: 'PT-common ICD-10-CM diagnoses',
    status: 'active',
    experimental: false,
    date: DATE,
    publisher: PUBLISHER,
    description: 'Starter pick list of ICD-10-CM diagnoses common in outpatient physical therapy. Not exhaustive.',
    copyright: 'ICD-10-CM is published by CDC/NCHS and is in the public domain.',
    compose: {
      include: [{ system: SYSTEMS.icd10cm, concept: PT_COMMON_ICD10.map((d) => ({ code: d.code, display: d.display })) }],
    },
  };
}
