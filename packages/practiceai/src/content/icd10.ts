/**
 * Small PT-common ICD-10-CM subset (starter pick list, not exhaustive).
 * ICD-10-CM is published by CDC/NCHS and is in the public domain. Any valid
 * ICD-10-CM code may still be documented; this list only drives suggestions.
 */

export interface Icd10Code {
  readonly code: string;
  readonly display: string;
}

export const PT_COMMON_ICD10: readonly Icd10Code[] = Object.freeze([
  { code: 'M54.50', display: 'Low back pain, unspecified' },
  { code: 'M54.59', display: 'Other low back pain' },
  { code: 'M54.2', display: 'Cervicalgia' },
  { code: 'M54.12', display: 'Radiculopathy, cervical region' },
  { code: 'M54.16', display: 'Radiculopathy, lumbar region' },
  { code: 'M48.061', display: 'Spinal stenosis, lumbar region without neurogenic claudication' },
  { code: 'M25.511', display: 'Pain in right shoulder' },
  { code: 'M25.512', display: 'Pain in left shoulder' },
  { code: 'M75.41', display: 'Impingement syndrome of right shoulder' },
  { code: 'M75.42', display: 'Impingement syndrome of left shoulder' },
  { code: 'M75.01', display: 'Adhesive capsulitis of right shoulder' },
  { code: 'M75.02', display: 'Adhesive capsulitis of left shoulder' },
  { code: 'M25.551', display: 'Pain in right hip' },
  { code: 'M25.552', display: 'Pain in left hip' },
  { code: 'M25.561', display: 'Pain in right knee' },
  { code: 'M25.562', display: 'Pain in left knee' },
  { code: 'M17.11', display: 'Unilateral primary osteoarthritis, right knee' },
  { code: 'M17.12', display: 'Unilateral primary osteoarthritis, left knee' },
  { code: 'S83.511A', display: 'Sprain of anterior cruciate ligament of right knee, initial encounter' },
  { code: 'S93.401A', display: 'Sprain of unspecified ligament of right ankle, initial encounter' },
  { code: 'M72.2', display: 'Plantar fascial fibromatosis' },
  { code: 'M62.81', display: 'Muscle weakness (generalized)' },
  { code: 'M62.838', display: 'Other muscle spasm' },
  { code: 'R26.2', display: 'Difficulty in walking, not elsewhere classified' },
  { code: 'R26.81', display: 'Unsteadiness on feet' },
  { code: 'R26.89', display: 'Other abnormalities of gait and mobility' },
  { code: 'G89.29', display: 'Other chronic pain' },
  { code: 'Z47.1', display: 'Aftercare following joint replacement surgery' },
  { code: 'Z96.651', display: 'Presence of right artificial knee joint' },
  { code: 'Z96.652', display: 'Presence of left artificial knee joint' },
]);
