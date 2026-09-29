/**
 * PT clinical documentation content, loaded into every practice project by
 * provisioning (conditional create keyed by canonical url + version).
 */
import type { CodeSystem, Questionnaire, ValueSet } from '@medplum/fhirtypes';
import { buildPtSoapQuestionnaire } from './questionnaire';
import { buildPtIcd10ValueSet, buildPtProcedureValueSet, buildPtVisitTypeCodeSystem, buildPtVisitTypeValueSet } from './terminology';

export * from './constants';
export * from './icd10';
export * from './pt-codes';
export * from './questionnaire';
export * from './terminology';

/** A canonical content resource (has url + version). */
export type ContentResource = (CodeSystem | ValueSet | Questionnaire) & { url: string; version: string };

/**
 * All PT content resources, in load order (CodeSystem before the ValueSets
 * that include it, ValueSets before the Questionnaire that binds them).
 */
export function ptContentResources(): ContentResource[] {
  return [
    buildPtVisitTypeCodeSystem(),
    buildPtVisitTypeValueSet(),
    buildPtProcedureValueSet(),
    buildPtIcd10ValueSet(),
    buildPtSoapQuestionnaire(),
  ] as ContentResource[];
}
