// Shared live fixture: two practice projects with every PracticeAI role, plus helpers that write
// clinical data exactly the way the billing app does (billing: src/lib/fhir/pt-note.ts ptNoteToFhir,
// gateway-core.ts signEncounter / createAddendum).

import type {
  AccessPolicy,
  Condition,
  Coverage,
  DocumentReference,
  Encounter,
  Patient,
  Procedure,
  ProjectMembership,
  QuestionnaireResponse,
  Reference,
} from '@medplum/fhirtypes';
import type { PracticeRole } from '../../src/policies';
import {
  CONTENT_HASH_EXT,
  ENCOUNTER_SIGNATURE_EXT,
  LOINC_ADDENDUM,
  LOINC_PROGRESS_NOTE,
  LOINC_SYSTEM,
  NOTE_LINE_SYSTEM,
  PLATFORM_FHIR_BASE,
  buildSignLockEntries,
  createPracticeProject,
  createRoleClient,
  inviteRoleUser,
  upsertPracticePolicies,
} from '../../src/policies';
import { ADMIN_EMAIL, ADMIN_PASSWORD, Actor, clientLogin, expectAllowed, passwordLogin, runId } from './harness';

export const PASSWORD = 'Synthetic-Test-Pw-2026!';

export interface PracticeFixture {
  run: string;
  projectId: string;
  policies: Record<PracticeRole, AccessPolicy & { id: string }>;
  actors: Record<PracticeRole | 'provider2', Actor>;
  practitioner: Reference; // provider1
  practitioner2: Reference;
  memberships: Partial<Record<PracticeRole | 'provider2', ProjectMembership>>;
  integrationClient: { id: string; secret: string };
  patient: Patient & { id: string };
  coverage: Coverage & { id: string };
}

export interface Fixture {
  superAdmin: Actor;
  a: PracticeFixture;
  b: PracticeFixture;
}

const HUMAN_ROLES: (PracticeRole | 'provider2')[] = [
  'provider',
  'provider2',
  'front_office',
  'biller',
  'rcm_supervisor',
  'practice_admin',
];

async function setupPracticeProject(superAdmin: Actor, label: string): Promise<PracticeFixture> {
  const run = runId();
  const admin = superAdmin.client;
  const project = await createPracticeProject(admin, `practiceai-test-${label}-${run}`);
  const policies = await upsertPracticePolicies(admin, { projectId: project.id, practiceLabel: `test-${label}` });

  const actors = {} as PracticeFixture['actors'];
  const memberships: PracticeFixture['memberships'] = {};
  for (const role of HUMAN_ROLES) {
    const policyRole: PracticeRole = role === 'provider2' ? 'provider' : role;
    const email = `${role.replace('_', '-')}-${label}-${run}@synthetic.example.com`;
    memberships[role] = await inviteRoleUser(admin, {
      projectId: project.id,
      policy: policies[policyRole],
      firstName: 'Synthetic',
      lastName: `${role}-${label}`,
      email,
      password: PASSWORD,
    });
    actors[role] = new Actor(`${role}@${label}`, await passwordLogin(email, PASSWORD, project.id));
  }

  const ai = await createRoleClient(admin, project.id, policies.ai_service, `ai-service-${label}-${run}`);
  actors.ai_service = new Actor(`ai_service@${label}`, await clientLogin(ai.id, ai.secret));
  const integ = await createRoleClient(admin, project.id, policies.integration, `billing-platform-${label}-${run}`);
  actors.integration = new Actor(`integration@${label}`, await clientLogin(integ.id, integ.secret));

  const practitioner = memberships.provider?.profile as Reference;
  const practitioner2 = memberships.provider2?.profile as Reference;

  // Intake the way the app does it, through the integration client.
  const p = await actors.integration.create<Patient>({
    resourceType: 'Patient',
    name: [{ given: ['Synthetic'], family: `Patient-${label}` }],
    birthDate: '1970-01-01',
    gender: 'unknown',
    identifier: [{ system: `${PLATFORM_FHIR_BASE}/sid/mrn`, value: `MRN-${run}` }],
    telecom: [{ system: 'phone', value: '555-0100' }],
  });
  expectAllowed(p, 'integration creates Patient');
  const cov = await actors.integration.create<Coverage>({
    resourceType: 'Coverage',
    status: 'active',
    beneficiary: { reference: `Patient/${p.body.id}` },
    payor: [{ display: 'Synthetic Payer' }],
    subscriberId: `SUB-${run}`,
  });
  expectAllowed(cov, 'integration creates Coverage');

  return {
    run,
    projectId: project.id,
    policies,
    actors,
    practitioner,
    practitioner2,
    memberships,
    integrationClient: { id: integ.id, secret: integ.secret },
    patient: p.body,
    coverage: cov.body,
  };
}

export async function setupFixture(): Promise<Fixture> {
  const superAdmin = new Actor('super_admin', await passwordLogin(ADMIN_EMAIL, ADMIN_PASSWORD));
  const a = await setupPracticeProject(superAdmin, 'a');
  const b = await setupPracticeProject(superAdmin, 'b');
  return { superAdmin, a, b };
}

// ------------------------------------------------------------------ clinical data (app shapes)

export interface NoteSet {
  encounter: Encounter & { id: string };
  condition: Condition & { id: string };
  procedure: Procedure & { id: string };
  questionnaireResponse: QuestionnaireResponse & { id: string };
}

export function draftEncounter(patientRef: string, practitionerRef: string): Encounter {
  return {
    resourceType: 'Encounter',
    status: 'in-progress',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
    subject: { reference: patientRef },
    type: [{ coding: [{ system: `${PLATFORM_FHIR_BASE}/CodeSystem/pt-visit-type`, code: 'follow_up' }] }],
    participant: [
      {
        type: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
                code: 'PPRF',
                display: 'primary performer',
              },
            ],
          },
        ],
        individual: { reference: practitionerRef },
      },
    ],
    period: { start: '2026-09-01T09:00:00Z' },
  };
}

/**
 * Writes an unsigned PT note (Encounter + Condition + Procedure + SOAP QuestionnaireResponse) as one transaction.
 * @param actor - The identity performing the writes.
 * @param patientRef - Reference string of the Patient.
 * @param practitionerRef - Reference string of the treating/signing Practitioner.
 * @returns The result of writeDraftNote.
 */
export async function writeDraftNote(actor: Actor, patientRef: string, practitionerRef: string): Promise<NoteSet> {
  const encUrn = 'urn:uuid:' + crypto.randomUUID();
  const condUrn = 'urn:uuid:' + crypto.randomUUID();
  const res = await actor.transaction([
    {
      fullUrl: encUrn,
      request: { method: 'POST', url: 'Encounter' },
      resource: draftEncounter(patientRef, practitionerRef),
    },
    {
      fullUrl: condUrn,
      request: { method: 'POST', url: 'Condition' },
      resource: {
        resourceType: 'Condition',
        identifier: [{ system: NOTE_LINE_SYSTEM, value: 'condition-0' }],
        clinicalStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }],
        },
        verificationStatus: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }],
        },
        category: [
          {
            coding: [
              { system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis' },
            ],
          },
        ],
        code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'M54.50' }] },
        subject: { reference: patientRef },
        encounter: { reference: encUrn },
        recordedDate: '2026-09-01',
      },
    },
    {
      request: { method: 'POST', url: 'Procedure' },
      resource: {
        resourceType: 'Procedure',
        identifier: [{ system: NOTE_LINE_SYSTEM, value: 'procedure-0' }],
        extension: [
          { url: `${PLATFORM_FHIR_BASE}/StructureDefinition/procedure-timed`, valueBoolean: true },
          { url: `${PLATFORM_FHIR_BASE}/StructureDefinition/procedure-minutes`, valueInteger: 30 },
        ],
        status: 'completed',
        code: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '97110' }] },
        subject: { reference: patientRef },
        encounter: { reference: encUrn },
        performedDateTime: '2026-09-01T09:00:00Z',
        performer: [{ actor: { reference: practitionerRef } }],
        reasonReference: [{ reference: condUrn }],
      },
    },
    {
      request: { method: 'POST', url: 'QuestionnaireResponse' },
      resource: {
        resourceType: 'QuestionnaireResponse',
        identifier: { system: NOTE_LINE_SYSTEM, value: 'soap' },
        questionnaire: `${PLATFORM_FHIR_BASE}/Questionnaire/pt-soap-note|1`,
        status: 'in-progress',
        subject: { reference: patientRef },
        encounter: { reference: encUrn },
        author: { reference: practitionerRef },
        item: [{ linkId: 'subjective', text: 'Subjective', answer: [{ valueString: 'Synthetic subjective text' }] }],
      },
    },
  ]);
  expectAllowed(res, `${actor.name} writes draft note`);
  const [encounter, condition, procedure, questionnaireResponse] = res.body.entry.map((e: any) => e.resource);
  return { encounter, condition, procedure, questionnaireResponse };
}

export interface SignedNote extends NoteSet {
  noteDocument: DocumentReference & { id: string };
}

/**
 * Signs like the app's signEncounter: PUT Encounter (status finished + signature extension, If-Match),
 * PUT QuestionnaireResponse (completed), POST the signed note DocumentReference (docStatus final).
 * With lockChildren, also stamps the signed-content lock label on the Condition/Procedure
 * (buildSignLockEntries) — the change the app must adopt so those are server-locked too.
 * @param actor - The identity performing the writes.
 * @param set - The unsigned note resources.
 * @param practitionerRef - Reference string of the treating/signing Practitioner.
 * @param options - Optional settings.
 * @param options.lockChildren - Also stamp the signed-content lock label on the Condition/Procedure.
 * @returns The result of signNote.
 */
export async function signNote(
  actor: Actor,
  set: NoteSet,
  practitionerRef: string,
  options: { lockChildren?: boolean } = {}
): Promise<SignedNote> {
  const signedAt = '2026-09-01T10:00:00.000Z';
  const noteUrn = 'urn:uuid:' + crypto.randomUUID();
  const encounter: Encounter = {
    ...set.encounter,
    status: 'finished',
    period: { ...set.encounter.period, end: signedAt },
    extension: [
      {
        url: ENCOUNTER_SIGNATURE_EXT,
        extension: [
          { url: 'signedAt', valueDateTime: signedAt },
          { url: 'signedBy', valueReference: { reference: practitionerRef } },
          { url: 'contentHash', valueString: 'synthetic-hash' },
          { url: 'noteDocument', valueReference: { reference: noteUrn } },
        ],
      },
    ],
  };
  const entries: any[] = [
    {
      request: { method: 'PUT', url: `Encounter/${set.encounter.id}`, ifMatch: `W/"${set.encounter.meta?.versionId}"` },
      resource: encounter,
    },
    {
      request: { method: 'PUT', url: `QuestionnaireResponse/${set.questionnaireResponse.id}` },
      resource: { ...set.questionnaireResponse, status: 'completed', authored: signedAt },
    },
    {
      fullUrl: noteUrn,
      request: { method: 'POST', url: 'DocumentReference' },
      resource: {
        resourceType: 'DocumentReference',
        extension: [{ url: CONTENT_HASH_EXT, valueString: 'synthetic-hash' }],
        status: 'current',
        docStatus: 'final',
        type: { coding: [{ system: LOINC_SYSTEM, code: LOINC_PROGRESS_NOTE, display: 'Progress note' }] },
        subject: set.encounter.subject,
        date: signedAt,
        author: [{ reference: practitionerRef }],
        authenticator: { reference: practitionerRef },
        description: 'Signed PT note',
        content: [
          {
            attachment: {
              contentType: 'text/plain',
              data: Buffer.from('Synthetic signed PT note').toString('base64'),
              title: 'Signed PT note',
              creation: signedAt,
            },
          },
        ],
        context: { encounter: [{ reference: `Encounter/${set.encounter.id}` }], period: encounter.period },
      } satisfies DocumentReference,
    },
  ];
  if (options.lockChildren) {
    entries.push(...buildSignLockEntries([set.condition, set.procedure]));
  }
  const res = await actor.transaction(entries);
  expectAllowed(res, `${actor.name} signs encounter`);
  const out = res.body.entry.map((e: any) => e.resource);
  const byType = (t: string): any => out.find((r: any) => r.resourceType === t);
  return {
    encounter: byType('Encounter'),
    questionnaireResponse: byType('QuestionnaireResponse'),
    noteDocument: byType('DocumentReference'),
    condition: out.find((r: any) => r.resourceType === 'Condition') ?? set.condition,
    procedure: out.find((r: any) => r.resourceType === 'Procedure') ?? set.procedure,
  };
}

/**
 * The app's addendum shape (createAddendum).
 * @param signed - The signed note the addendum appends to.
 * @param authorRef - Reference string of the addendum author.
 * @param overrides - Fields to override (to build invalid variants).
 * @returns The result of addendum.
 */
export function addendum(
  signed: SignedNote,
  authorRef: string,
  overrides: Partial<DocumentReference> = {}
): DocumentReference {
  const now = new Date().toISOString();
  return {
    resourceType: 'DocumentReference',
    extension: [{ url: CONTENT_HASH_EXT, valueString: 'synthetic-addendum-hash' }],
    status: 'current',
    docStatus: 'final',
    type: { coding: [{ system: LOINC_SYSTEM, code: LOINC_ADDENDUM, display: 'Addendum Document' }] },
    subject: signed.encounter.subject,
    date: now,
    author: [{ reference: authorRef }],
    description: 'Addendum to signed PT note',
    relatesTo: [{ code: 'appends', target: { reference: `DocumentReference/${signed.noteDocument.id}` } }],
    content: [
      {
        attachment: {
          contentType: 'text/plain',
          data: Buffer.from('Synthetic addendum').toString('base64'),
          title: 'Addendum',
          creation: now,
        },
      },
    ],
    context: { encounter: [{ reference: `Encounter/${signed.encounter.id}` }] },
    ...overrides,
  };
}

export function strip<T extends { meta?: unknown }>(r: T): Omit<T, 'meta'> {
  const { meta: _meta, ...rest } = r;
  return rest;
}
