// SPDX-License-Identifier: Apache-2.0
/* eslint-disable header/header -- PracticeAI file: no Orangebot copyright line; platform header pending (packages/practiceai/README.md) */
//
// PRACTICEAI (fork-local): end-to-end tests of the signed-content guard through the real HTTP stack
// (FHIR REST, batch/transaction, GraphQL, $expunge, /admin routes), for every kind of identity.

import type { WithId } from '@medplum/core';
import { createReference, getReferenceString, Operator } from '@medplum/core';
import type {
  AccessPolicy,
  AuditEvent,
  Binary,
  Bundle,
  ClientApplication,
  DocumentReference,
  Encounter,
  Login,
  OperationOutcome,
  Patient,
  Practitioner,
  Procedure,
  Project,
  ProjectMembership,
  QuestionnaireResponse,
  Resource,
  User,
} from '@medplum/fhirtypes';
import express from 'express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { initApp, shutdownApp } from '../app';
import { loadTestConfig } from '../config/loader';
import type { SystemRepository } from '../fhir/repo';
import { getProjectSystemRepo } from '../fhir/repo';
import { generateAccessToken } from '../oauth/keys';
import { getSuperAdminAccessToken, withTestContext } from '../test.setup';
import { LockReason } from './guard';
import { ENCOUNTER_SIGNATURE_EXT, LOCK_OUTCOME_SYSTEM, PRACTICEAI_SIGNED_LOCK_SETTING } from './signed-lock';

const app = express();
const FHIR = '/fhir/R4/';
const CLINICAL = [
  'Patient',
  'Encounter',
  'Condition',
  'Procedure',
  'Observation',
  'ClinicalImpression',
  'QuestionnaireResponse',
  'DocumentReference',
  'Composition',
  'Claim',
  'AccessPolicy',
  'AuditEvent',
  'ClientApplication',
  'Binary',
];

/** A broad policy with NO write constraints: proves the guard does not depend on AccessPolicies. */
const BROAD_POLICY: Partial<AccessPolicy> = {
  name: 'broad (no write constraints)',
  resource: CLINICAL.map((resourceType) => ({ resourceType })),
};

interface Identity {
  readonly name: string;
  readonly token: string;
  readonly membership: WithId<ProjectMembership>;
}

type IdentityKind = 'projectAdmin' | 'memberNoPolicy' | 'clientNoPolicy' | 'provider' | 'integration';
const MEMBER_KINDS: IdentityKind[] = ['projectAdmin', 'memberNoPolicy', 'clientNoPolicy', 'provider', 'integration'];

interface Practice {
  project: WithId<Project>;
  sys: SystemRepository;
  policy: WithId<AccessPolicy>;
  ids: Record<IdentityKind, Identity>;
  patient: WithId<Patient>;
  practitioner: WithId<Practitioner>;
}

async function createProject(flagged: boolean, name: string): Promise<WithId<Project>> {
  const sys = await getProjectSystemRepo('');
  return sys.createResource<Project>({
    resourceType: 'Project',
    name,
    strictMode: true,
    features: ['transaction-bundles', 'bots'],
    systemSetting: flagged ? [{ name: PRACTICEAI_SIGNED_LOCK_SETTING, valueBoolean: true }] : undefined,
  });
}

async function createIdentity(
  project: WithId<Project>,
  name: string,
  options: { kind: 'client' | 'user'; policy?: WithId<AccessPolicy>; admin?: boolean }
): Promise<Identity> {
  const sys = await getProjectSystemRepo(project);
  let user: WithId<User | ClientApplication>;
  let profile: WithId<Practitioner | ClientApplication>;
  if (options.kind === 'client') {
    user = await sys.createResource<ClientApplication>({
      resourceType: 'ClientApplication',
      meta: { project: project.id },
      name,
      secret: randomUUID(),
    });
    profile = user;
  } else {
    profile = await sys.createResource<Practitioner>({
      resourceType: 'Practitioner',
      meta: { project: project.id },
      name: [{ given: [name], family: 'Synthetic' }],
    });
    user = await sys.createResource<User>({
      resourceType: 'User',
      firstName: name,
      lastName: 'Synthetic',
      email: `${randomUUID()}@synthetic.example`,
      project: createReference(project),
    });
  }
  const membership = await sys.createResource<ProjectMembership>({
    resourceType: 'ProjectMembership',
    project: createReference(project),
    user: createReference(user),
    profile: createReference(profile),
    accessPolicy: options.policy ? createReference(options.policy) : undefined,
    admin: options.admin,
  });
  const login = await sys.createResource<Login>({
    resourceType: 'Login',
    authMethod: options.kind === 'client' ? 'client' : 'password',
    user: createReference(user),
    client: options.kind === 'client' ? createReference(user as ClientApplication) : undefined,
    membership: createReference(membership),
    authTime: new Date().toISOString(),
    scope: 'openid',
  });
  const token = await generateAccessToken({
    login_id: login.id,
    sub: user.id,
    username: user.id,
    client_id: options.kind === 'client' ? user.id : undefined,
    profile: getReferenceString(profile),
    scope: 'openid',
  });
  return { name, token, membership };
}

async function createPractice(flagged: boolean): Promise<Practice> {
  const project = await createProject(flagged, `practiceai-guard-${flagged ? 'on' : 'off'}-${randomUUID()}`);
  const sys = await getProjectSystemRepo(project);
  const policy = await sys.createResource<AccessPolicy>({
    resourceType: 'AccessPolicy',
    meta: { project: project.id },
    ...BROAD_POLICY,
  });
  const ids = {
    projectAdmin: await createIdentity(project, 'projectAdmin', { kind: 'client', policy, admin: true }),
    memberNoPolicy: await createIdentity(project, 'memberNoPolicy', { kind: 'user' }),
    clientNoPolicy: await createIdentity(project, 'clientNoPolicy', { kind: 'client' }),
    provider: await createIdentity(project, 'provider', { kind: 'user', policy }),
    integration: await createIdentity(project, 'integration', { kind: 'client', policy }),
  };
  const patient = await sys.createResource<Patient>({
    resourceType: 'Patient',
    meta: { project: project.id },
    name: [{ given: ['Synthetic'], family: 'Guard' }],
  });
  const practitioner = await sys.createResource<Practitioner>({
    resourceType: 'Practitioner',
    meta: { project: project.id },
    name: [{ given: ['Pat'], family: 'Placeholder' }],
  });
  return { project, sys, policy, ids, patient, practitioner };
}

const ENCOUNTER_SID = 'https://practiceai.example/fhir/sid/encounter';

interface SignedEncounter {
  encounter: WithId<Encounter>;
  /** The encounter's business identifier (for logical-reference attacks). */
  identifier: { system: string; value: string };
  procedure: WithId<Procedure>;
  condition: WithId<Resource>;
  qr: WithId<QuestionnaireResponse>;
  note: WithId<DocumentReference>;
}

/**
 * Builds a signed encounter the way the billing app does (children written before signing, no lock label).
 * @param p - The practice.
 * @returns The signed encounter and its children.
 */
async function createSignedEncounter(p: Practice): Promise<SignedEncounter> {
  const meta = { project: p.project.id };
  const subject = createReference(p.patient);
  const identifier = { system: ENCOUNTER_SID, value: `ENC-${randomUUID()}` };
  const draft = await p.sys.createResource<Encounter>({
    resourceType: 'Encounter',
    meta,
    identifier: [identifier],
    status: 'in-progress',
    class: { code: 'AMB' },
    subject,
    participant: [{ individual: createReference(p.practitioner) }],
  });
  const encounterRef = { reference: `Encounter/${draft.id}` };
  const procedure = await p.sys.createResource<Procedure>({
    resourceType: 'Procedure',
    meta,
    status: 'completed',
    subject,
    encounter: encounterRef,
    code: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '97110' }] },
  });
  const condition = await p.sys.createResource<Resource>({
    resourceType: 'Condition',
    meta,
    subject,
    encounter: encounterRef,
    code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'M54.50' }] },
  });
  const qr = await p.sys.createResource<QuestionnaireResponse>({
    resourceType: 'QuestionnaireResponse',
    meta,
    status: 'completed',
    subject,
    encounter: encounterRef,
  });
  const note = await p.sys.createResource<DocumentReference>({
    resourceType: 'DocumentReference',
    meta,
    status: 'current',
    docStatus: 'final',
    subject,
    date: new Date().toISOString(),
    author: [createReference(p.practitioner)],
    content: [{ attachment: { contentType: 'text/plain', data: 'U2lnbmVkIG5vdGU=' } }],
    context: { encounter: [encounterRef] },
  });
  const encounter = await p.sys.updateResource<Encounter>({
    ...draft,
    status: 'finished',
    extension: [
      { url: ENCOUNTER_SIGNATURE_EXT, extension: [{ url: 'signedAt', valueDateTime: new Date().toISOString() }] },
    ],
  });
  return { encounter, identifier, procedure, condition, qr, note };
}

function auth(token: string): Record<string, string> {
  return { Authorization: 'Bearer ' + token };
}

function expectLocked(res: request.Response, code: LockReason, label: string): void {
  expect({ label, status: res.status }).toEqual({ label, status: 403 });
  const outcome = res.body as OperationOutcome;
  expect({ label, coding: outcome.issue?.[0]?.details?.coding?.[0] }).toEqual({
    label,
    coding: { system: LOCK_OUTCOME_SYSTEM, code },
  });
}

async function post(token: string, path: string, body: unknown): Promise<request.Response> {
  return request(app)
    .post(path)
    .set(auth(token))
    .set('Content-Type', 'application/fhir+json')
    .send(body as object);
}
async function put(token: string, path: string, body: unknown): Promise<request.Response> {
  return request(app)
    .put(path)
    .set(auth(token))
    .set('Content-Type', 'application/fhir+json')
    .send(body as object);
}

function newChildren(p: Practice, encounterId: string): Resource[] {
  const subject = createReference(p.patient);
  const encounter = { reference: `Encounter/${encounterId}` };
  return [
    { resourceType: 'Procedure', status: 'completed', subject, encounter, code: { text: '97140' } },
    { resourceType: 'Condition', subject, encounter, code: { text: 'M25.561' } },
    { resourceType: 'Observation', status: 'final', subject, encounter, code: { text: 'ROM' } },
    { resourceType: 'ClinicalImpression', status: 'completed', subject, encounter },
    { resourceType: 'QuestionnaireResponse', status: 'completed', subject, encounter },
    { resourceType: 'QuestionnaireResponse', status: 'in-progress', subject, encounter },
    {
      resourceType: 'DocumentReference',
      status: 'current',
      docStatus: 'final',
      subject,
      date: new Date().toISOString(),
      author: [createReference(p.practitioner)],
      content: [{ attachment: { contentType: 'text/plain', data: 'VGFtcGVy' } }],
      context: { encounter: [encounter] },
    },
    {
      resourceType: 'Composition',
      status: 'final',
      type: { text: 'progress note' },
      subject,
      encounter,
      date: new Date().toISOString(),
      author: [createReference(p.practitioner)],
      title: 'Progress note',
    },
  ];
}

function addendum(p: Practice, s: SignedEncounter, overrides: Partial<DocumentReference> = {}): DocumentReference {
  return {
    resourceType: 'DocumentReference',
    status: 'current',
    docStatus: 'final',
    subject: createReference(p.patient),
    date: new Date().toISOString(),
    author: [createReference(p.practitioner)],
    description: 'Addendum',
    relatesTo: [{ code: 'appends', target: { reference: `DocumentReference/${s.note.id}` } }],
    content: [{ attachment: { contentType: 'text/plain', data: 'QWRkZW5kdW0=' } }],
    context: { encounter: [{ reference: `Encounter/${s.encounter.id}` }] },
    ...overrides,
  };
}

async function breakGlassAudits(p: Practice, target: string): Promise<WithId<AuditEvent>[]> {
  const events = await p.sys.searchResources<AuditEvent>({
    resourceType: 'AuditEvent',
    filters: [
      { code: '_project', operator: Operator.EQUALS, value: p.project.id },
      { code: 'entity', operator: Operator.EQUALS, value: target },
    ],
    count: 100,
  });
  return events.filter((e) => e.purposeOfEvent?.[0]?.coding?.[0]?.code === 'BTG');
}

describe('PracticeAI signed-content guard', () => {
  let on: Practice;
  let off: Practice;
  let superToken: string;

  beforeAll(async () => {
    const config = await loadTestConfig();
    await withTestContext(() => initApp(app, config));
    on = await withTestContext(() => createPractice(true));
    off = await withTestContext(() => createPractice(false));
    superToken = await getSuperAdminAccessToken();
  });

  afterAll(async () => {
    await shutdownApp();
  });

  describe.each(MEMBER_KINDS)('flagged project, identity %s', (kind) => {
    let s: SignedEncounter;
    let token: string;

    beforeAll(async () => {
      s = await withTestContext(() => createSignedEncounter(on));
      token = on.ids[kind].token;
    });

    test('update / patch / status revert of signed Encounter, note, QR -> 403', async () => {
      expectLocked(
        await put(token, `${FHIR}Encounter/${s.encounter.id}`, {
          ...s.encounter,
          status: 'in-progress',
          extension: undefined,
        }),
        LockReason.SignedContent,
        'PUT Encounter'
      );
      const patch = await request(app)
        .patch(`${FHIR}DocumentReference/${s.note.id}`)
        .set(auth(token))
        .set('Content-Type', 'application/json-patch+json')
        .send([{ op: 'replace', path: '/docStatus', value: 'preliminary' }]);
      expectLocked(patch, LockReason.SignedContent, 'PATCH note');
      expectLocked(
        await put(token, `${FHIR}QuestionnaireResponse/${s.qr.id}`, { ...s.qr, status: 'in-progress' }),
        LockReason.SignedContent,
        'PUT QR'
      );
      const cond = await put(token, `${FHIR}Encounter?_id=${s.encounter.id}`, { ...s.encounter, status: 'cancelled' });
      expectLocked(cond, LockReason.SignedContent, 'conditional PUT Encounter');
    });

    test('children of a signed encounter WITHOUT lock label are locked (hole 2)', async () => {
      expectLocked(
        await put(token, `${FHIR}Procedure/${s.procedure.id}`, { ...s.procedure, code: { text: 'tampered' } }),
        LockReason.SignedEncounter,
        'PUT Procedure'
      );
      expectLocked(
        await request(app).delete(`${FHIR}Condition/${s.condition.id}`).set(auth(token)),
        LockReason.SignedEncounter,
        'DELETE Condition'
      );
      expectLocked(
        await request(app).delete(`${FHIR}DocumentReference/${s.note.id}`).set(auth(token)),
        LockReason.SignedContent,
        'DELETE note'
      );
      expectLocked(
        await request(app).delete(`${FHIR}Encounter?_id=${s.encounter.id}`).set(auth(token)),
        LockReason.SignedContent,
        'conditional DELETE Encounter'
      );
    });

    test('create of a clinical child referencing the signed encounter -> 403 (hole 1)', async () => {
      for (const child of newChildren(on, s.encounter.id)) {
        expectLocked(
          await post(token, `${FHIR}${child.resourceType}`, child),
          LockReason.SignedEncounter,
          child.resourceType
        );
      }
      // absolute and versioned references resolve too
      const abs = {
        ...newChildren(on, s.encounter.id)[0],
        encounter: { reference: `http://localhost:8103/fhir/R4/Encounter/${s.encounter.id}/_history/1` },
      };
      expectLocked(await post(token, `${FHIR}Procedure`, abs), LockReason.SignedEncounter, 'absolute reference');
      // PUT-create (conditional create by update) is refused too
      const upsert = await put(
        token,
        `${FHIR}Procedure?identifier=urn:x|${randomUUID()}`,
        newChildren(on, s.encounter.id)[0]
      );
      expectLocked(upsert, LockReason.SignedEncounter, 'conditional PUT create');
    });

    test('moving a draft child into the signed encounter -> 403', async () => {
      const draft = await withTestContext(() =>
        on.sys.createResource<Procedure>({
          resourceType: 'Procedure',
          meta: { project: on.project.id },
          status: 'in-progress',
          subject: createReference(on.patient),
          code: { text: '97110' },
        })
      );
      expectLocked(
        await put(token, `${FHIR}Procedure/${draft.id}`, {
          ...draft,
          encounter: { reference: `Encounter/${s.encounter.id}` },
        }),
        LockReason.SignedEncounter,
        'move into signed encounter'
      );
    });

    test('addendum is allowed; malformed addenda are not; addendum is immutable', async () => {
      const ok = await post(token, `${FHIR}DocumentReference`, addendum(on, s));
      expect(ok.status).toBe(201);
      expectLocked(
        await put(token, `${FHIR}DocumentReference/${ok.body.id}`, { ...ok.body, description: 'edited' }),
        LockReason.SignedContent,
        'edit addendum'
      );
      const bad: [string, Partial<DocumentReference>][] = [
        ['replaces', { relatesTo: [{ code: 'replaces', target: { reference: `DocumentReference/${s.note.id}` } }] }],
        ['no author', { author: undefined }],
        ['no date', { date: undefined }],
        ['preliminary', { docStatus: 'preliminary' }],
        ['no relatesTo', { relatesTo: undefined }],
        [
          'target not a signed note',
          { relatesTo: [{ code: 'appends', target: { reference: `DocumentReference/${randomUUID()}` } }] },
        ],
      ];
      for (const [label, overrides] of bad) {
        expectLocked(
          await post(token, `${FHIR}DocumentReference`, addendum(on, s, overrides)),
          LockReason.SignedEncounter,
          label
        );
      }
      // appends a signed note of ANOTHER encounter
      const other = await withTestContext(() => createSignedEncounter(on));
      const wrongNote = addendum(on, s, {
        relatesTo: [{ code: 'appends', target: { reference: `DocumentReference/${other.note.id}` } }],
      });
      expectLocked(
        await post(token, `${FHIR}DocumentReference`, wrongNote),
        LockReason.SignedEncounter,
        'note of other encounter'
      );
    });

    test('batch and transaction entries go through the guard', async () => {
      const batch = await post(token, FHIR, {
        resourceType: 'Bundle',
        type: 'batch',
        entry: [
          {
            request: { method: 'PUT', url: `Encounter/${s.encounter.id}` },
            resource: { ...s.encounter, status: 'in-progress' },
          },
          { request: { method: 'POST', url: 'Procedure' }, resource: newChildren(on, s.encounter.id)[0] },
          { request: { method: 'DELETE', url: `DocumentReference/${s.note.id}` } },
        ],
      } satisfies Bundle);
      expect(batch.status).toBe(200);
      expect((batch.body as Bundle).entry?.map((e) => e.response?.status)).toEqual(['403', '403', '403']);

      const tx = await post(token, FHIR, {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          { request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient' } },
          { request: { method: 'POST', url: 'Procedure' }, resource: newChildren(on, s.encounter.id)[0] },
        ],
      } satisfies Bundle);
      expect(tx.status).toBe(403);
    });

    test('GraphQL mutations go through the guard', async () => {
      const gql = async (query: string): Promise<request.Response> =>
        request(app).post(`${FHIR}$graphql`).set(auth(token)).set('Content-Type', 'application/json').send({ query });
      const create = await gql(
        `mutation { ProcedureCreate(res: { resourceType: "Procedure", status: "completed", subject: { reference: "Patient/${on.patient.id}" }, encounter: { reference: "Encounter/${s.encounter.id}" } }) { id } }`
      );
      expect(create.body.data?.ProcedureCreate ?? null).toBeNull();
      expect(JSON.stringify(create.body.errors)).toContain('signed');
      const update = await gql(
        `mutation { EncounterUpdate(id: "${s.encounter.id}", res: { resourceType: "Encounter", id: "${s.encounter.id}", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/${on.patient.id}" } }) { id } }`
      );
      expect(update.body.data?.EncounterUpdate ?? null).toBeNull();
      const del = await gql(`mutation { ProcedureDelete(id: "${s.procedure.id}") { id } }`);
      expect(del.body.data?.ProcedureDelete ?? null).toBeNull();
    });

    test('Binary behind a signed note: no overwrite, delete or upload URL (bypass 1)', async () => {
      const binary = await withTestContext(() =>
        on.sys.createResource<Binary>({
          resourceType: 'Binary',
          meta: { project: on.project.id },
          contentType: 'text/plain',
          data: Buffer.from('Signed note body').toString('base64'),
        })
      );
      const note = await withTestContext(() =>
        on.sys.createResource<DocumentReference>({
          resourceType: 'DocumentReference',
          meta: { project: on.project.id },
          status: 'current',
          docStatus: 'final',
          subject: createReference(on.patient),
          date: new Date().toISOString(),
          author: [createReference(on.practitioner)],
          content: [{ attachment: { contentType: 'text/plain', url: `Binary/${binary.id}` } }],
          context: { encounter: [{ reference: `Encounter/${s.encounter.id}` }] },
        })
      );
      const raw = await request(app)
        .put(`${FHIR}Binary/${binary.id}`)
        .set(auth(token))
        .set('Content-Type', 'text/plain')
        .send('FORGED SIGNED NOTE BODY');
      expectLocked(raw, LockReason.BinaryImmutable, 'raw PUT Binary');
      expectLocked(
        await put(token, `${FHIR}Binary/${binary.id}`, {
          resourceType: 'Binary',
          id: binary.id,
          contentType: 'text/plain',
          data: Buffer.from('FORGED').toString('base64'),
        }),
        LockReason.BinaryImmutable,
        'FHIR PUT Binary'
      );
      expectLocked(
        await request(app).delete(`${FHIR}Binary/${binary.id}`).set(auth(token)),
        LockReason.BinaryImmutable,
        'DELETE Binary'
      );
      expectLocked(
        await request(app).get(`${FHIR}Binary/${binary.id}/$presigned-url?upload=true`).set(auth(token)),
        LockReason.BinaryImmutable,
        'presigned upload URL'
      );
      const batch = await post(token, FHIR, {
        resourceType: 'Bundle',
        type: 'batch',
        entry: [
          {
            request: { method: 'PUT', url: `Binary/${binary.id}` },
            resource: { resourceType: 'Binary', id: binary.id, contentType: 'text/plain', data: 'Rk9SR0VE' },
          },
        ],
      } satisfies Bundle);
      expect((batch.body as Bundle).entry?.[0]?.response?.status).toBe('403');
      // content and versions unchanged
      const stored = await on.sys.readResource<Binary>('Binary', binary.id);
      expect(stored.meta?.versionId).toBe(binary.meta?.versionId);
      const body = await request(app).get(`${FHIR}Binary/${binary.id}`).set(auth(token)).set('Accept', 'text/plain');
      expect(body.status).toBe(200);
      expect(body.text).toBe('Signed note body');
      const n = await on.sys.readResource<DocumentReference>('DocumentReference', note.id);
      expect(n.meta?.versionId).toBe(note.meta?.versionId);
      // new Binaries (e.g. an addendum's content) are still created normally; a read-only URL is fine
      const fresh = await request(app)
        .post(`${FHIR}Binary`)
        .set(auth(token))
        .set('Content-Type', 'text/plain')
        .send('Addendum body');
      expect(fresh.status).toBe(201);
      expect(
        (await request(app).get(`${FHIR}Binary/${binary.id}/$presigned-url`).set(auth(token))).status
      ).toBe(200);
    });

    test('logical (identifier) and other-element encounter references are resolved (bypasses 2, 3)', async () => {
      const subject = createReference(on.patient);
      const logical = { type: 'Encounter' as const, identifier: s.identifier };
      const cases: [string, Resource, LockReason][] = [
        [
          'Procedure encounter.identifier (typed)',
          { resourceType: 'Procedure', status: 'completed', subject, encounter: logical, code: { text: 'x' } },
          LockReason.SignedEncounter,
        ],
        [
          'Observation encounter.identifier (untyped)',
          {
            resourceType: 'Observation',
            status: 'final',
            subject,
            encounter: { identifier: s.identifier },
            code: { text: 'x' },
          },
          LockReason.SignedEncounter,
        ],
        [
          'non-addendum DocumentReference context.encounter.identifier',
          {
            resourceType: 'DocumentReference',
            status: 'current',
            docStatus: 'preliminary',
            type: { text: 'shadow note' },
            subject,
            context: { encounter: [logical] },
            content: [{ attachment: { contentType: 'text/plain', data: 'c2hhZG93' } }],
          },
          LockReason.SignedEncounter,
        ],
        [
          'Observation focus -> signed Encounter (no .encounter)',
          {
            resourceType: 'Observation',
            status: 'final',
            subject,
            focus: [{ reference: `Encounter/${s.encounter.id}` }],
            code: { text: 'x' },
          },
          LockReason.SignedEncounter,
        ],
        [
          'Condition evidence.detail logical ref',
          { resourceType: 'Condition', subject, evidence: [{ detail: [logical] }], code: { text: 'x' } },
          LockReason.SignedEncounter,
        ],
        [
          'literal draft ref + signed identifier on the same Reference',
          {
            resourceType: 'Procedure',
            status: 'completed',
            subject,
            encounter: { reference: `Encounter/${randomUUID()}`, identifier: s.identifier },
            code: { text: 'x' },
          },
          LockReason.SignedEncounter,
        ],
        [
          'identifier-only link that matches no encounter',
          {
            resourceType: 'Procedure',
            status: 'completed',
            subject,
            encounter: { identifier: { system: ENCOUNTER_SID, value: `ENC-${randomUUID()}` } },
            code: { text: 'x' },
          },
          LockReason.EncounterReferenceInvalid,
        ],
        [
          'contained encounter carrying the signed identifier',
          {
            resourceType: 'Procedure',
            status: 'completed',
            subject,
            contained: [
              { resourceType: 'Encounter', id: 'c', status: 'finished', class: { code: 'AMB' }, identifier: [s.identifier] },
            ],
            encounter: { reference: '#c' },
            code: { text: 'x' },
          },
          LockReason.EncounterReferenceInvalid,
        ],
        [
          'identifier-only addendum (would otherwise be a valid addendum)',
          addendum(on, s, { context: { encounter: [logical] } }),
          LockReason.SignedEncounter,
        ],
      ];
      for (const [label, resource, code] of cases) {
        expectLocked(await post(token, `${FHIR}${resource.resourceType}`, resource), code, label);
      }
      // batch and transaction entries with a logical reference
      const batch = await post(token, FHIR, {
        resourceType: 'Bundle',
        type: 'batch',
        entry: [{ request: { method: 'POST', url: 'Procedure' }, resource: cases[0][1] }],
      } satisfies Bundle);
      expect((batch.body as Bundle).entry?.[0]?.response?.status).toBe('403');
      // moving a draft into the signed encounter with a logical reference
      const draft = await withTestContext(() =>
        on.sys.createResource<Procedure>({
          resourceType: 'Procedure',
          meta: { project: on.project.id },
          status: 'in-progress',
          subject,
          code: { text: '97110' },
        })
      );
      expectLocked(
        await put(token, `${FHIR}Procedure/${draft.id}`, { ...draft, encounter: logical }),
        LockReason.SignedEncounter,
        'move into signed encounter via identifier'
      );
      // a legacy child linked only by identifier (written before the flag / by the system) is locked too
      const legacy = await withTestContext(() =>
        on.sys.createResource<Procedure>({
          resourceType: 'Procedure',
          meta: { project: on.project.id },
          status: 'completed',
          subject,
          encounter: logical,
          code: { text: '97110' },
        })
      );
      expectLocked(
        await put(token, `${FHIR}Procedure/${legacy.id}`, { ...legacy, code: { text: 'tampered' } }),
        LockReason.SignedEncounter,
        'PUT legacy identifier-linked child'
      );
      expectLocked(
        await request(app).delete(`${FHIR}Procedure/${legacy.id}`).set(auth(token)),
        LockReason.SignedEncounter,
        'DELETE legacy identifier-linked child'
      );
      // a proper (literal) addendum is still allowed
      expect((await post(token, `${FHIR}DocumentReference`, addendum(on, s))).status).toBe(201);
    });

    test('signed resources are unchanged after every attempt', async () => {
      const enc = await on.sys.readResource<Encounter>('Encounter', s.encounter.id);
      expect(enc.meta?.versionId).toBe(s.encounter.meta?.versionId);
      const proc = await on.sys.readResource<Procedure>('Procedure', s.procedure.id);
      expect(proc.meta?.versionId).toBe(s.procedure.meta?.versionId);
      const note = await on.sys.readResource<DocumentReference>('DocumentReference', s.note.id);
      expect(note.meta?.versionId).toBe(s.note.meta?.versionId);
      const children = await on.sys.searchResources<Procedure>({
        resourceType: 'Procedure',
        filters: [{ code: 'encounter', operator: Operator.EQUALS, value: `Encounter/${s.encounter.id}` }],
      });
      expect(children.map((c) => c.id)).toEqual([s.procedure.id]);
    });

    test('ordinary clinical work is unaffected (draft encounter, claims)', async () => {
      const draft = await post(token, `${FHIR}Encounter`, {
        resourceType: 'Encounter',
        status: 'in-progress',
        class: { code: 'AMB' },
        subject: createReference(on.patient),
      });
      expect(draft.status).toBe(201);
      const child = await post(token, `${FHIR}Procedure`, newChildren(on, draft.body.id)[0]);
      expect(child.status).toBe(201);
      const edit = await put(token, `${FHIR}Procedure/${child.body.id}`, { ...child.body, code: { text: '97112' } });
      expect(edit.status).toBe(200);
      const claim = await post(token, `${FHIR}Claim`, {
        resourceType: 'Claim',
        status: 'draft',
        use: 'claim',
        type: { text: 'professional' },
        patient: createReference(on.patient),
        created: new Date().toISOString(),
        provider: createReference(on.practitioner),
        priority: { text: 'normal' },
        insurance: [{ sequence: 1, focal: true, coverage: { display: 'synthetic' } }],
        item: [
          {
            sequence: 1,
            productOrService: { text: '97110' },
            encounter: [{ reference: `Encounter/${s.encounter.id}` }],
          },
        ],
      });
      expect(claim.status).toBe(201);
    });

    test('$expunge is refused in a flagged project', async () => {
      const res = await post(token, `${FHIR}DocumentReference/${s.note.id}/$expunge`, {});
      expect(res.status).toBe(403);
      if (kind === 'projectAdmin') {
        expectLocked(res, LockReason.Expunge, 'expunge note');
        expectLocked(
          await post(token, `${FHIR}Project/${on.project.id}/$expunge`, {}),
          LockReason.Expunge,
          'expunge project'
        );
        expectLocked(
          await post(token, `${FHIR}Patient/${on.patient.id}/$expunge?everything=true`, {}),
          LockReason.Expunge,
          'expunge everything'
        );
      }
      const note = await on.sys.readResource<DocumentReference>('DocumentReference', s.note.id);
      expect(note.id).toBe(s.note.id);
    });

    test('AccessPolicy writes and AuditEvent edits are refused', async () => {
      expectLocked(
        await post(token, `${FHIR}AccessPolicy`, {
          resourceType: 'AccessPolicy',
          name: 'x',
          resource: [{ resourceType: '*' }],
        }),
        LockReason.AccessPolicyAdmin,
        'create AccessPolicy'
      );
      expectLocked(
        await put(token, `${FHIR}AccessPolicy/${on.policy.id}`, { ...on.policy, resource: [{ resourceType: '*' }] }),
        LockReason.AccessPolicyAdmin,
        'update AccessPolicy'
      );
      const ae = await post(token, `${FHIR}AuditEvent`, {
        resourceType: 'AuditEvent',
        type: { code: 'rest' },
        recorded: new Date().toISOString(),
        source: { observer: { display: 'synthetic' } },
        agent: [{ requestor: true }],
      });
      expect(ae.status).toBe(201);
      expectLocked(
        await put(token, `${FHIR}AuditEvent/${ae.body.id}`, { ...ae.body, outcome: '8' }),
        LockReason.AuditImmutable,
        'edit AuditEvent'
      );
      expectLocked(
        await request(app).delete(`${FHIR}AuditEvent/${ae.body.id}`).set(auth(token)),
        LockReason.AuditImmutable,
        'delete AuditEvent'
      );
    });
  });

  describe('flagged project: admin / policy bypasses (hole 3)', () => {
    let admin: Identity;

    beforeAll(() => {
      admin = on.ids.projectAdmin;
    });

    test('project admin cannot remove its own policy or grant admin', async () => {
      const own = admin.membership;
      expectLocked(
        await put(admin.token, `${FHIR}ProjectMembership/${own.id}`, { ...own, accessPolicy: undefined }),
        LockReason.MembershipPolicyRequired,
        'blank own policy'
      );
      expectLocked(
        await post(admin.token, `/admin/projects/${on.project.id}/members/${own.id}`, {
          ...own,
          accessPolicy: undefined,
          access: [],
        }),
        LockReason.MembershipPolicyRequired,
        'admin route blank own policy'
      );
      const provider = on.ids.provider.membership;
      expectLocked(
        await put(admin.token, `${FHIR}ProjectMembership/${provider.id}`, { ...provider, admin: true }),
        LockReason.MembershipAdmin,
        'grant admin'
      );
      const patch = await request(app)
        .patch(`${FHIR}ProjectMembership/${provider.id}`)
        .set(auth(admin.token))
        .set('Content-Type', 'application/json-patch+json')
        .send([{ op: 'remove', path: '/accessPolicy' }]);
      expectLocked(patch, LockReason.MembershipPolicyRequired, 'patch remove policy');
      // A policy from another project is refused
      expectLocked(
        await put(admin.token, `${FHIR}ProjectMembership/${provider.id}`, {
          ...provider,
          accessPolicy: createReference(off.policy),
        }),
        LockReason.MembershipPolicyForeign,
        'foreign policy'
      );
      // Deactivating a membership is allowed
      const legacy = await withTestContext(() => createIdentity(on.project, 'legacyNoPolicy', { kind: 'user' }));
      const deactivate = await put(admin.token, `${FHIR}ProjectMembership/${legacy.membership.id}`, {
        ...legacy.membership,
        active: false,
      });
      expect(deactivate.status).toBe(200);
    });

    test('memberships, clients, bots and invites must carry a policy from the same project', async () => {
      expectLocked(
        await post(admin.token, `/admin/projects/${on.project.id}/client`, { name: 'unrestricted' }),
        LockReason.MembershipPolicyRequired,
        'client without policy'
      );
      expectLocked(
        await post(admin.token, `/admin/projects/${on.project.id}/client`, {
          name: 'foreign',
          accessPolicy: createReference(off.policy),
        }),
        LockReason.MembershipPolicyForeign,
        'client with foreign policy'
      );
      const good = await post(admin.token, `/admin/projects/${on.project.id}/client`, {
        name: 'restricted',
        accessPolicy: createReference(on.policy),
      });
      expect(good.status).toBe(201);

      expectLocked(
        await post(admin.token, `/admin/projects/${on.project.id}/bot`, { name: 'bot' }),
        LockReason.MembershipPolicyRequired,
        'bot without policy'
      );
      expectLocked(
        await request(app)
          .post(`${FHIR}Bot/$init`)
          .set(auth(admin.token))
          .set('Content-Type', 'application/fhir+json')
          .send({ resourceType: 'Parameters', parameter: [{ name: 'name', valueString: 'bot' }] }),
        LockReason.MembershipPolicyRequired,
        'Bot/$init without policy'
      );

      const invite = (body: object): Promise<request.Response> =>
        post(admin.token, `/admin/projects/${on.project.id}/invite`, {
          resourceType: 'Practitioner',
          firstName: 'Invited',
          lastName: 'Synthetic',
          email: `${randomUUID()}@synthetic.example`,
          sendEmail: false,
          ...body,
        });
      expectLocked(await invite({}), LockReason.MembershipPolicyRequired, 'invite without policy');
      expectLocked(
        await invite({ accessPolicy: createReference(on.policy), admin: true }),
        LockReason.MembershipAdmin,
        'invite as admin'
      );
      expect((await invite({ accessPolicy: createReference(on.policy) })).status).toBe(200);

      expectLocked(
        await post(admin.token, `${FHIR}ProjectMembership`, {
          resourceType: 'ProjectMembership',
          project: createReference(on.project),
          user: createReference(on.practitioner),
          profile: createReference(on.practitioner),
        }),
        LockReason.MembershipPolicyRequired,
        'FHIR create membership without policy'
      );
    });

    test('project settings are super-admin only; systemSetting cannot be removed by a project admin', async () => {
      expectLocked(
        await post(admin.token, `/admin/projects/${on.project.id}/settings`, [{ name: 'x', valueString: 'y' }]),
        LockReason.ProjectSettings,
        'admin settings route'
      );
      const project = (await request(app).get(`${FHIR}Project/${on.project.id}`).set(auth(admin.token)))
        .body as Project;
      expectLocked(
        await put(admin.token, `${FHIR}Project/${on.project.id}`, { ...project, checkReferencesOnWrite: true }),
        LockReason.ProjectSettings,
        'checkReferencesOnWrite'
      );
      expectLocked(
        await put(admin.token, `${FHIR}Project/${on.project.id}`, {
          ...project,
          setting: [{ name: 'a', valueString: 'b' }],
        }),
        LockReason.ProjectSettings,
        'setting'
      );
      // systemSetting is a readonly field for project admins upstream: the write is silently restored.
      const strip = await put(admin.token, `${FHIR}Project/${on.project.id}`, {
        ...project,
        systemSetting: [],
        name: project.name,
      });
      expect([200, 403]).toContain(strip.status);
      const stored = await on.sys.readResource<Project>('Project', on.project.id);
      expect(stored.systemSetting).toEqual([{ name: PRACTICEAI_SIGNED_LOCK_SETTING, valueBoolean: true }]);
      const patch = await request(app)
        .patch(`${FHIR}Project/${on.project.id}`)
        .set(auth(admin.token))
        .set('Content-Type', 'application/json-patch+json')
        .send([{ op: 'remove', path: '/systemSetting' }]);
      expect([200, 403]).toContain(patch.status);
      expect((await on.sys.readResource<Project>('Project', on.project.id)).systemSetting).toEqual(
        stored.systemSetting
      );
    });

    test('non-admin identities cannot touch the Project resource at all (upstream)', async () => {
      for (const kind of ['memberNoPolicy', 'clientNoPolicy', 'provider', 'integration'] as const) {
        const res = await put(on.ids[kind].token, `${FHIR}Project/${on.project.id}`, {
          resourceType: 'Project',
          id: on.project.id,
          name: 'x',
          systemSetting: [],
        });
        expect({ kind, status: res.status }).toEqual({ kind, status: 403 });
      }
    });
  });

  describe('signing still works through a transaction', () => {
    test('Encounter PUT finished + QR PUT completed + note POST in one transaction; later edits refused', async () => {
      const token = on.ids.integration.token;
      const enc = await post(token, `${FHIR}Encounter`, {
        resourceType: 'Encounter',
        status: 'in-progress',
        class: { code: 'AMB' },
        subject: createReference(on.patient),
      });
      const qr = await post(token, `${FHIR}QuestionnaireResponse`, {
        resourceType: 'QuestionnaireResponse',
        status: 'in-progress',
        subject: createReference(on.patient),
        encounter: { reference: `Encounter/${enc.body.id}` },
      });
      const proc = await post(token, `${FHIR}Procedure`, newChildren(on, enc.body.id)[0]);
      expect([enc.status, qr.status, proc.status]).toEqual([201, 201, 201]);
      const tx = await post(token, FHIR, {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          {
            request: { method: 'PUT', url: `Encounter/${enc.body.id}`, ifMatch: `W/"${enc.body.meta.versionId}"` },
            resource: {
              ...enc.body,
              status: 'finished',
              extension: [
                {
                  url: ENCOUNTER_SIGNATURE_EXT,
                  extension: [{ url: 'signedAt', valueDateTime: new Date().toISOString() }],
                },
              ],
            },
          },
          {
            request: { method: 'PUT', url: `QuestionnaireResponse/${qr.body.id}` },
            resource: { ...qr.body, status: 'completed' },
          },
          {
            fullUrl: 'urn:uuid:4f1c7b8e-0a5e-4f58-9b61-3c0e1c7e2d11',
            request: { method: 'POST', url: 'DocumentReference' },
            resource: {
              resourceType: 'DocumentReference',
              status: 'current',
              docStatus: 'final',
              date: new Date().toISOString(),
              author: [createReference(on.practitioner)],
              subject: createReference(on.patient),
              content: [{ attachment: { contentType: 'text/plain', data: 'U2lnbmVk' } }],
              context: { encounter: [{ reference: `Encounter/${enc.body.id}` }] },
            },
          },
        ],
      } satisfies Bundle);
      expect({ status: tx.status, body: tx.status === 200 ? undefined : tx.body }).toEqual({
        status: 200,
        body: undefined,
      });
      expectLocked(
        await put(token, `${FHIR}Procedure/${proc.body.id}`, { ...proc.body, code: { text: 'x' } }),
        LockReason.SignedEncounter,
        'after sign'
      );
    });
  });

  describe('super admin is break-glass: allowed and audited', () => {
    test('update, create child, delete and expunge in a flagged project are allowed and produce BTG AuditEvents', async () => {
      const s = await withTestContext(() => createSignedEncounter(on));
      const upd = await put(superToken, `${FHIR}Procedure/${s.procedure.id}`, {
        ...s.procedure,
        meta: { project: on.project.id },
        code: { text: 'corrected' },
      });
      expect(upd.status).toBe(200);
      const created = await post(superToken, `${FHIR}Observation`, {
        ...newChildren(on, s.encounter.id)[2],
        meta: { project: on.project.id },
      });
      expect(created.status).toBe(201);
      const del = await request(app).delete(`${FHIR}Condition/${s.condition.id}`).set(auth(superToken));
      expect(del.status).toBe(200);
      const exp = await post(superToken, `${FHIR}QuestionnaireResponse/${s.qr.id}/$expunge`, {});
      expect(exp.status).toBe(200);

      for (const target of [
        `Procedure/${s.procedure.id}`,
        `Observation/${created.body.id}`,
        `Condition/${s.condition.id}`,
        `QuestionnaireResponse/${s.qr.id}`,
      ]) {
        const audits = await withTestContext(() => breakGlassAudits(on, target));
        expect({ target, n: audits.length > 0 }).toEqual({ target, n: true });
        expect(audits[0].outcomeDesc).toContain('PRACTICEAI break-glass');
        expect(audits[0].meta?.project).toBe(on.project.id);
      }
    });

    test('Binary overwrite by the super admin is allowed and audited', async () => {
      const binary = await withTestContext(() =>
        on.sys.createResource<Binary>({
          resourceType: 'Binary',
          meta: { project: on.project.id },
          contentType: 'text/plain',
          data: Buffer.from('v1').toString('base64'),
        })
      );
      const res = await request(app)
        .put(`${FHIR}Binary/${binary.id}`)
        .set(auth(superToken))
        .set('Content-Type', 'text/plain')
        .send('corrected by super admin');
      expect(res.status).toBe(200);
      const audits = await withTestContext(() => breakGlassAudits(on, `Binary/${binary.id}`));
      expect(audits.length).toBeGreaterThan(0);
      expect(audits[0].outcomeDesc).toContain(LockReason.BinaryImmutable);
    });

    test('routine super-admin configuration (AccessPolicy, membership) is allowed without a break-glass record', async () => {
      const pol = await post(superToken, `${FHIR}AccessPolicy`, {
        resourceType: 'AccessPolicy',
        meta: { project: on.project.id },
        name: 'provisioned',
        resource: [{ resourceType: 'Patient' }],
      });
      expect(pol.status).toBe(201);
      expect(await withTestContext(() => breakGlassAudits(on, `AccessPolicy/${pol.body.id}`))).toHaveLength(0);
      const client = await post(superToken, `/admin/projects/${on.project.id}/client`, {
        name: 'provisioned client',
        accessPolicy: { reference: `AccessPolicy/${pol.body.id}` },
      });
      expect(client.status).toBe(201);
    });

    test('super admin can set and clear the project flag (systemSetting), clearing is audited', async () => {
      const p = await withTestContext(() => createProject(true, 'practiceai-guard-flag-' + randomUUID()));
      const res = await put(superToken, `${FHIR}Project/${p.id}`, { ...p, systemSetting: [] });
      expect(res.status).toBe(200);
      const sys = await getProjectSystemRepo(p);
      const audits = await withTestContext(() =>
        sys.searchResources<AuditEvent>({
          resourceType: 'AuditEvent',
          filters: [{ code: 'entity', operator: Operator.EQUALS, value: `Project/${p.id}` }],
        })
      );
      expect(audits.some((a) => a.purposeOfEvent?.[0]?.coding?.[0]?.code === 'BTG')).toBe(true);
    });
  });

  describe('unflagged project: upstream behavior unchanged', () => {
    test.each(MEMBER_KINDS)('%s: signed content editable per AccessPolicy only', async (kind) => {
      const s = await withTestContext(() => createSignedEncounter(off));
      const token = off.ids[kind].token;
      expect(
        (await put(token, `${FHIR}Encounter/${s.encounter.id}`, { ...s.encounter, status: 'in-progress' })).status
      ).toBe(200);
      expect((await post(token, `${FHIR}Procedure`, newChildren(off, s.encounter.id)[0])).status).toBe(201);
      expect((await request(app).delete(`${FHIR}Condition/${s.condition.id}`).set(auth(token))).status).toBe(200);
      expect((await post(token, `${FHIR}AccessPolicy`, { resourceType: 'AccessPolicy', name: 'x' })).status).toBe(201);
      const logical = await post(token, `${FHIR}Procedure`, {
        ...newChildren(off, s.encounter.id)[0],
        encounter: { identifier: s.identifier },
      });
      expect(logical.status).toBe(201);
      const bin = await request(app).post(`${FHIR}Binary`).set(auth(token)).set('Content-Type', 'text/plain').send('a');
      expect(bin.status).toBe(201);
      const over = await request(app)
        .put(`${FHIR}Binary/${bin.body.id}`)
        .set(auth(token))
        .set('Content-Type', 'text/plain')
        .send('b');
      expect(over.status).toBe(200);
    });

    test('project admin keeps its upstream powers', async () => {
      const admin = off.ids.projectAdmin;
      const s = await withTestContext(() => createSignedEncounter(off));
      expect((await post(admin.token, `/admin/projects/${off.project.id}/client`, { name: 'no policy' })).status).toBe(
        201
      );
      expect(
        (await post(admin.token, `/admin/projects/${off.project.id}/settings`, [{ name: 'x', valueString: 'y' }]))
          .status
      ).toBe(200);
      expect((await post(admin.token, `${FHIR}DocumentReference/${s.note.id}/$expunge`, {})).status).toBe(200);
      const provider = off.ids.provider.membership;
      expect(
        (await put(admin.token, `${FHIR}ProjectMembership/${provider.id}`, { ...provider, admin: true })).status
      ).toBe(200);
    });
  });

  describe('cross-project encounter references', () => {
    test('reference to a signed encounter in ANOTHER project: not resolvable, not a bypass', async () => {
      const other = await withTestContext(() => createPractice(true));
      const foreign = await withTestContext(() => createSignedEncounter(other));
      const token = on.ids.integration.token;
      // Treated as not locked in this project (the reference does not resolve here) ...
      const res = await post(token, `${FHIR}Procedure`, newChildren(on, foreign.encounter.id)[0]);
      expect(res.status).toBe(201);
      // ... and gives no access to the other project's signed content.
      expect((await request(app).get(`${FHIR}Encounter/${foreign.encounter.id}`).set(auth(token))).status).toBe(404);
      expect(
        (await put(token, `${FHIR}Encounter/${foreign.encounter.id}`, { ...foreign.encounter, status: 'in-progress' }))
          .status
      ).not.toBe(200);
      const enc = await other.sys.readResource<Encounter>('Encounter', foreign.encounter.id);
      expect(enc.meta?.versionId).toBe(foreign.encounter.meta?.versionId);
      // The other project's own identities still cannot attach to it.
      expectLocked(
        await post(other.ids.integration.token, `${FHIR}Procedure`, newChildren(other, foreign.encounter.id)[0]),
        LockReason.SignedEncounter,
        'owner project'
      );
    });
  });
});
