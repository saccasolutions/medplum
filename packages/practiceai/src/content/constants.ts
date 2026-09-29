/**
 * FHIR URLs shared with the billing app.
 *
 * These values MUST stay identical to /home/user/billing/src/lib/fhir/constants.ts
 * (PLATFORM_FHIR_BASE, SYSTEMS, EXT, PT_SOAP_QUESTIONNAIRE). The billing app's
 * MedplumFhirGateway writes Encounter/Procedure/Condition/QuestionnaireResponse
 * resources with these URLs, and the content loaded here (Questionnaire,
 * ValueSets, CodeSystem) describes the same model. test/content/*.test.ts pins
 * the values; when the billing repo is present it also compares them.
 */

export const PLATFORM_FHIR_BASE = 'https://practiceai.example/fhir';

const SD = `${PLATFORM_FHIR_BASE}/StructureDefinition`;
const SID = `${PLATFORM_FHIR_BASE}/sid`;
const CS = `${PLATFORM_FHIR_BASE}/CodeSystem`;
const VS = `${PLATFORM_FHIR_BASE}/ValueSet`;
const Q = `${PLATFORM_FHIR_BASE}/Questionnaire`;

/** Code / identifier systems (subset of the billing app's SYSTEMS). */
export const SYSTEMS = {
  npi: 'http://hl7.org/fhir/sid/us-npi',
  tin: 'urn:oid:2.16.840.1.113883.4.4',
  cpt: 'http://www.ama-assn.org/go/cpt',
  hcpcs: 'https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets',
  cptModifier: 'http://www.ama-assn.org/go/cpt-modifier',
  icd10cm: 'http://hl7.org/fhir/sid/icd-10-cm',
  taxonomy: 'http://nucc.org/provider-taxonomy',
  placeOfService: 'https://www.cms.gov/Medicare/Coding/place-of-service-codes/Place_of_Service_Code_Set',
  organizationType: 'http://terminology.hl7.org/CodeSystem/organization-type',
  /** Platform code system for the PT visit type (Encounter.type). */
  ptVisitType: `${CS}/pt-visit-type`,
} as const;

/** Extension URLs used on the Encounter / Procedure resources the questionnaire describes. */
export const EXT = {
  minutes: `${SD}/procedure-minutes`,
  timed: `${SD}/procedure-timed`,
  modifier: `${SD}/procedure-modifier`,
  units: `${SD}/procedure-units`,
  placeOfService: `${SD}/place-of-service`,
  coverage: `${SD}/encounter-coverage`,
  planOfCare: `${SD}/plan-of-care`,
  certificationPeriod: `${SD}/plan-of-care-certification`,
  authorization: `${SD}/prior-authorization`,
  visitNumber: `${SD}/visit-number`,
  referringProvider: `${SD}/referring-provider`,
  totalTreatmentMinutes: `${SD}/total-treatment-minutes`,
  taxonomy: `${SD}/provider-taxonomy`,
} as const;

/** Sub-extension URLs of the prior-authorization complex extension. */
export const SUB_EXT = {
  authNumber: 'number',
  authStart: 'start',
  authEnd: 'end',
  authVisitsAuthorized: 'visitsAuthorized',
  authVisitsUsed: 'visitsUsed',
} as const;

/** Canonical URL of the PT SOAP note questionnaire (billing: `${url}|${version}`). */
export const PT_SOAP_QUESTIONNAIRE_URL = `${Q}/pt-soap-note`;
export const PT_SOAP_QUESTIONNAIRE_VERSION = '1';
export const PT_SOAP_QUESTIONNAIRE = `${PT_SOAP_QUESTIONNAIRE_URL}|${PT_SOAP_QUESTIONNAIRE_VERSION}`;

/** Canonical URLs of the terminology resources defined by this package. */
export const CONTENT_URLS = {
  ptVisitTypeCodeSystem: SYSTEMS.ptVisitType,
  ptVisitTypeValueSet: `${VS}/pt-visit-type`,
  ptProcedureValueSet: `${VS}/pt-procedure-codes`,
  ptIcd10ValueSet: `${VS}/pt-common-icd10`,
  /** Complex-free extension on ValueSet concepts: whether the code is a timed (15-minute) code. */
  conceptTimed: `${SD}/pt-code-timed`,
  /** Extension on ValueSet concepts: PT code category (evaluation / therapeutic_procedure / modality / other). */
  conceptCategory: `${SD}/pt-code-category`,
} as const;

/** Identifier systems used by provisioning (billing organization UUID, provisioning keys). */
export const PROVISIONING_SYSTEMS = {
  /** Billing-app organization UUID; set on the Project and the practice Organization. */
  organizationId: `${SID}/organization-id`,
  /** Stable key of a platform-provisioned user profile (e.g. "practice-admin:<email>"). */
  provisionedUser: `${SID}/provisioned-user`,
} as const;
