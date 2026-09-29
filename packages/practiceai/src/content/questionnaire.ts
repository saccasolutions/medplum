/**
 * PT daily note / evaluation / re-evaluation Questionnaire.
 *
 * Canonical: https://practiceai.example/fhir/Questionnaire/pt-soap-note, version 1
 * (the billing app writes QuestionnaireResponse.questionnaire =
 * `${url}|1`). Compatibility contract with the billing PT note model
 * (/home/user/billing/src/lib/fhir/pt-note.ts):
 *
 *   - The four SOAP sections are TOP-LEVEL `text` items with linkIds
 *     `subjective`, `objective`, `assessment`, `plan`, exactly the items the
 *     billing app writes into the QuestionnaireResponse.
 *   - Every other field of the PT note is stored by the billing app on
 *     structured resources (Encounter extensions, Condition, Procedure). The
 *     questionnaire still lists those fields (visit type, interventions with
 *     CPT + minutes, diagnoses, plan-of-care reference, authorization number,
 *     ...) so a form can capture the whole note; each such item's
 *     `definition` names the FHIR element / platform extension that holds the
 *     value, and none of them is `required`, so a response carrying only the
 *     SOAP answers (what the billing app writes) is a valid response.
 */
import type { Questionnaire, QuestionnaireItem } from '@medplum/fhirtypes';
import { CONTENT_URLS, EXT, PT_SOAP_QUESTIONNAIRE_URL, PT_SOAP_QUESTIONNAIRE_VERSION, SUB_EXT, SYSTEMS } from './constants';
import { PT_MODIFIERS } from './pt-codes';

const FHIR_SD = 'http://hl7.org/fhir/StructureDefinition';
const MIN_VALUE = `${FHIR_SD}/minValue`;
const MAX_VALUE = `${FHIR_SD}/maxValue`;
const REFERENCE_RESOURCE = `${FHIR_SD}/questionnaire-referenceResource`;

/** linkIds of the SOAP sections written by the billing app. */
export const SOAP_LINK_IDS = ['subjective', 'objective', 'assessment', 'plan'] as const;

function intRange(min: number, max: number): QuestionnaireItem['extension'] {
  return [
    { url: MIN_VALUE, valueInteger: min },
    { url: MAX_VALUE, valueInteger: max },
  ];
}

function soap(linkId: (typeof SOAP_LINK_IDS)[number], text: string, prefix: string): QuestionnaireItem {
  return {
    linkId,
    prefix,
    text,
    type: 'text',
    required: true,
    maxLength: 20000,
    definition: `${FHIR_SD}/QuestionnaireResponse#QuestionnaireResponse.item`,
  };
}

export function buildPtSoapQuestionnaire(): Questionnaire {
  const visit: QuestionnaireItem = {
    linkId: 'visit',
    text: 'Visit',
    type: 'group',
    item: [
      {
        linkId: 'visit.visitType',
        text: 'Visit type',
        type: 'choice',
        answerValueSet: CONTENT_URLS.ptVisitTypeValueSet,
        definition: `${FHIR_SD}/Encounter#Encounter.type`,
      },
      { linkId: 'visit.serviceDate', text: 'Date of service', type: 'date', definition: `${FHIR_SD}/Encounter#Encounter.period.start` },
      { linkId: 'visit.startTime', text: 'Start time', type: 'dateTime', definition: `${FHIR_SD}/Encounter#Encounter.period.start` },
      { linkId: 'visit.endTime', text: 'End time', type: 'dateTime', definition: `${FHIR_SD}/Encounter#Encounter.period.end` },
      {
        linkId: 'visit.placeOfService',
        text: 'Place of service (CMS 2-digit code)',
        type: 'string',
        maxLength: 2,
        initial: [{ valueString: '11' }],
        definition: EXT.placeOfService,
      },
      { linkId: 'visit.visitNumber', text: 'Visit number', type: 'integer', extension: intRange(1, 999), definition: EXT.visitNumber },
      {
        linkId: 'visit.totalTreatmentMinutes',
        text: 'Total treatment minutes',
        type: 'integer',
        extension: intRange(0, 720),
        definition: EXT.totalTreatmentMinutes,
      },
      {
        linkId: 'visit.referringProviderNpi',
        text: 'Referring provider NPI',
        type: 'string',
        maxLength: 10,
        definition: EXT.referringProvider,
      },
      {
        linkId: 'visit.coverage',
        text: 'Coverage billed for this visit',
        type: 'reference',
        extension: [{ url: REFERENCE_RESOURCE, valueCode: 'Coverage' }],
        definition: EXT.coverage,
      },
    ],
  };

  const diagnoses: QuestionnaireItem = {
    linkId: 'diagnoses',
    text: 'Diagnoses (ICD-10-CM, in billing rank order)',
    type: 'group',
    repeats: true,
    definition: `${FHIR_SD}/Encounter#Encounter.diagnosis`,
    item: [
      {
        linkId: 'diagnoses.icd10',
        text: 'ICD-10-CM code',
        type: 'open-choice',
        answerValueSet: CONTENT_URLS.ptIcd10ValueSet,
        definition: `${FHIR_SD}/Condition#Condition.code`,
      },
      { linkId: 'diagnoses.description', text: 'Description', type: 'string', maxLength: 500 },
    ],
  };

  const interventions: QuestionnaireItem = {
    linkId: 'interventions',
    text: 'Interventions (one per CPT/HCPCS code)',
    type: 'group',
    repeats: true,
    definition: `${FHIR_SD}/Procedure`,
    item: [
      {
        linkId: 'interventions.cpt',
        text: 'CPT/HCPCS code',
        type: 'choice',
        answerValueSet: CONTENT_URLS.ptProcedureValueSet,
        definition: `${FHIR_SD}/Procedure#Procedure.code`,
      },
      {
        linkId: 'interventions.minutes',
        text: 'Minutes (required for timed codes)',
        type: 'integer',
        extension: intRange(0, 480),
        definition: EXT.minutes,
      },
      {
        linkId: 'interventions.units',
        text: 'Units (untimed codes only)',
        type: 'integer',
        extension: intRange(1, 99),
        definition: EXT.units,
      },
      {
        linkId: 'interventions.modifiers',
        text: 'Modifiers (default GP)',
        type: 'open-choice',
        repeats: true,
        answerOption: PT_MODIFIERS.map((m) => ({ valueCoding: { system: SYSTEMS.cptModifier, code: m.code, display: m.label } })),
        definition: EXT.modifier,
      },
      {
        linkId: 'interventions.diagnosisPointers',
        text: 'Diagnosis pointers (1-based)',
        type: 'integer',
        repeats: true,
        extension: intRange(1, 12),
        definition: `${FHIR_SD}/Procedure#Procedure.reasonReference`,
      },
      { linkId: 'interventions.description', text: 'Description', type: 'string', maxLength: 1000, definition: `${FHIR_SD}/Procedure#Procedure.note` },
    ],
  };

  const planOfCare: QuestionnaireItem = {
    linkId: 'planOfCare',
    text: 'Plan of care (required for daily notes and re-evaluations)',
    type: 'group',
    enableWhen: [{ question: 'visit.visitType', operator: '!=', answerCoding: { system: SYSTEMS.ptVisitType, code: 'eval' } }],
    item: [
      {
        linkId: 'planOfCare.ref',
        text: 'Plan of care',
        type: 'reference',
        extension: [
          { url: REFERENCE_RESOURCE, valueCode: 'CarePlan' },
          { url: REFERENCE_RESOURCE, valueCode: 'DocumentReference' },
        ],
        definition: EXT.planOfCare,
      },
      { linkId: 'planOfCare.certificationStart', text: 'Certification start', type: 'date', definition: EXT.certificationPeriod },
      { linkId: 'planOfCare.certificationEnd', text: 'Certification end', type: 'date', definition: EXT.certificationPeriod },
    ],
  };

  const authorization: QuestionnaireItem = {
    linkId: 'authorization',
    text: 'Prior authorization',
    type: 'group',
    definition: EXT.authorization,
    item: [
      { linkId: 'authorization.number', text: 'Authorization number', type: 'string', maxLength: 50, definition: `${EXT.authorization}#${SUB_EXT.authNumber}` },
      { linkId: 'authorization.startDate', text: 'Authorization start', type: 'date', definition: `${EXT.authorization}#${SUB_EXT.authStart}` },
      { linkId: 'authorization.endDate', text: 'Authorization end', type: 'date', definition: `${EXT.authorization}#${SUB_EXT.authEnd}` },
      {
        linkId: 'authorization.visitsAuthorized',
        text: 'Visits authorized',
        type: 'integer',
        extension: intRange(0, 999),
        definition: `${EXT.authorization}#${SUB_EXT.authVisitsAuthorized}`,
      },
      {
        linkId: 'authorization.visitsUsed',
        text: 'Visits used',
        type: 'integer',
        extension: intRange(0, 999),
        definition: `${EXT.authorization}#${SUB_EXT.authVisitsUsed}`,
      },
    ],
  };

  return {
    resourceType: 'Questionnaire',
    url: PT_SOAP_QUESTIONNAIRE_URL,
    version: PT_SOAP_QUESTIONNAIRE_VERSION,
    name: 'PtSoapNote',
    title: 'PT daily note / evaluation (SOAP)',
    status: 'active',
    experimental: false,
    date: '2026-09-29',
    publisher: 'PracticeAI platform (synthetic/dev content)',
    description:
      'Physical therapy daily treatment note, initial evaluation and re-evaluation. SOAP narrative is captured in the response; visit, diagnoses, interventions, plan of care and authorization are stored on Encounter/Condition/Procedure by the platform.',
    subjectType: ['Patient'],
    code: [{ system: 'http://loinc.org', code: '11506-3', display: 'Progress note' }],
    item: [
      visit,
      soap('subjective', 'Subjective', 'S'),
      soap('objective', 'Objective', 'O'),
      soap('assessment', 'Assessment', 'A'),
      soap('plan', 'Plan', 'P'),
      diagnoses,
      interventions,
      planOfCare,
      authorization,
    ],
  };
}
