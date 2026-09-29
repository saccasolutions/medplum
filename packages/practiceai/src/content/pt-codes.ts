/**
 * PT CPT/HCPCS subset used by the platform.
 *
 * Mirrors the codes, timed flags and categories of the billing app's catalog
 * (/home/user/billing/src/lib/fhir/pt-cpt.ts). Descriptions are SHORT,
 * PLATFORM-AUTHORED plain-language labels, not AMA CPT descriptors: CPT
 * descriptors are copyrighted by the American Medical Association and are not
 * reproduced here (see README "Terminology licensing"). The code values
 * themselves are used for interoperability; distributing full CPT descriptors
 * requires an AMA license. HCPCS Level II codes are published by CMS.
 */

export type PtCodeCategory = 'evaluation' | 'therapeutic_procedure' | 'modality' | 'other';

export interface PtProcedureCode {
  readonly code: string;
  /** Platform-authored short label (not the AMA descriptor). */
  readonly label: string;
  /** Timed (15-minute) code subject to the CMS 8-minute rule. */
  readonly timed: boolean;
  readonly category: PtCodeCategory;
  /** HCPCS Level II (CMS) rather than CPT (AMA). */
  readonly hcpcs: boolean;
}

function code(code: string, label: string, timed: boolean, category: PtCodeCategory, hcpcs = false): PtProcedureCode {
  return Object.freeze({ code, label, timed, category, hcpcs });
}

export const PT_PROCEDURE_CODES: readonly PtProcedureCode[] = Object.freeze([
  code('97161', 'PT evaluation, low complexity', false, 'evaluation'),
  code('97162', 'PT evaluation, moderate complexity', false, 'evaluation'),
  code('97163', 'PT evaluation, high complexity', false, 'evaluation'),
  code('97164', 'PT re-evaluation', false, 'evaluation'),
  code('97110', 'Therapeutic exercise, each 15 min', true, 'therapeutic_procedure'),
  code('97112', 'Neuromuscular re-education, each 15 min', true, 'therapeutic_procedure'),
  code('97113', 'Aquatic therapy, each 15 min', true, 'therapeutic_procedure'),
  code('97116', 'Gait training, each 15 min', true, 'therapeutic_procedure'),
  code('97140', 'Manual therapy techniques, each 15 min', true, 'therapeutic_procedure'),
  code('97150', 'Therapeutic procedures, group', false, 'therapeutic_procedure'),
  code('97530', 'Therapeutic activities, each 15 min', true, 'therapeutic_procedure'),
  code('97535', 'Self-care/home management training, each 15 min', true, 'therapeutic_procedure'),
  code('97542', 'Wheelchair management training, each 15 min', true, 'therapeutic_procedure'),
  code('97750', 'Physical performance test, each 15 min', true, 'therapeutic_procedure'),
  code('97760', 'Orthotic management and training, initial, each 15 min', true, 'therapeutic_procedure'),
  code('97761', 'Prosthetic training, initial, each 15 min', true, 'therapeutic_procedure'),
  code('97010', 'Hot or cold packs', false, 'modality'),
  code('97012', 'Mechanical traction', false, 'modality'),
  code('97014', 'Electrical stimulation, unattended', false, 'modality'),
  code('97016', 'Vasopneumatic device', false, 'modality'),
  code('97018', 'Paraffin bath', false, 'modality'),
  code('97022', 'Whirlpool', false, 'modality'),
  code('97032', 'Electrical stimulation, attended, each 15 min', true, 'modality'),
  code('97033', 'Iontophoresis, each 15 min', true, 'modality'),
  code('97035', 'Ultrasound, each 15 min', true, 'modality'),
  code('G0283', 'Electrical stimulation, unattended, other than wound care', false, 'modality', true),
]);

export const PT_EVALUATION_CODES: readonly string[] = ['97161', '97162', '97163'];
export const PT_REEVALUATION_CODES: readonly string[] = ['97164'];

/** Billing modifiers a PT note may carry (GP = services under a PT plan of care). */
export const PT_MODIFIERS: readonly { code: string; label: string }[] = Object.freeze([
  { code: 'GP', label: 'Services under an outpatient PT plan of care' },
  { code: 'KX', label: 'Requirements met (therapy threshold exceeded)' },
  { code: 'CQ', label: 'Services furnished in whole or in part by a PT assistant' },
  { code: '59', label: 'Distinct procedural service' },
  { code: 'XU', label: 'Unusual non-overlapping service' },
]);

/** PT visit types (billing PtVisitType) with platform display strings. */
export const PT_VISIT_TYPES: readonly { code: 'eval' | 're-eval' | 'daily'; display: string; definition: string }[] = Object.freeze([
  { code: 'eval', display: 'PT initial evaluation', definition: 'Initial physical therapy evaluation establishing the plan of care.' },
  { code: 're-eval', display: 'PT re-evaluation', definition: 'Formal re-evaluation under an established plan of care.' },
  { code: 'daily', display: 'PT daily treatment note', definition: 'Routine treatment visit under an established, certified plan of care.' },
]);
