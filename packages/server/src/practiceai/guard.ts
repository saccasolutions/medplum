// SPDX-License-Identifier: Apache-2.0
/* eslint-disable header/header -- PracticeAI file: no Orangebot copyright line; platform header pending (packages/practiceai/README.md) */
//
// PRACTICEAI (fork-local, not upstream): server-side signed-content guard.
//
// Enabled per project by Project.systemSetting `practiceai-signed-lock` = true (only super admins can write
// systemSetting; see guard.test.ts). In an enabled project it applies to EVERY identity except the super admin
// and the internal system repository: project admins, memberships/clients/bots without an AccessPolicy, and
// every role. It is independent of AccessPolicies, so it also closes the gaps policies cannot express
// (dereferencing Procedure.encounter, admin bypasses). Super admin writes that would be refused are allowed as
// break-glass and recorded as an AuditEvent (purposeOfEvent BTG) in the practice project plus a warn log line.
//
// Hooks (the only upstream edits, each marked `// PRACTICEAI:`):
//  - fhir/repo.ts updateResourceImpl  -> practiceAiGuardWrite    (create/update/patch, conditional, batch,
//                                                                  transaction, GraphQL: all go through it)
//  - fhir/repo.ts deleteResource      -> practiceAiGuardDelete
//  - fhir/repo.ts expungeResources    -> practiceAiGuardExpunge
//  - fhir/operations/expunge.ts       -> practiceAiGuardExpunge  (so Project/everything expunge fails with 403
//                                                                  instead of a 202 async job that then fails)
//  - fhir/operations/binary-presigned-url.ts -> practiceAiGuardBinaryUpload (upload URL = Binary overwrite)
//  - admin/client.ts createClient, fhir/operations/botinit.ts createBot, admin/invite.ts upsertProjectMembership
//                                     -> practiceAiGuardNewMembership (these write memberships with the system
//                                        repository on behalf of a project admin)

import { OperationOutcomeError, Operator, stringify } from '@medplum/core';
import { RepositoryMode } from '@medplum/fhir-router';
import type {
  AccessPolicy,
  AuditEvent,
  DocumentReference,
  Encounter,
  OperationOutcome,
  Project,
  ProjectMembership,
  Reference,
  Resource,
  ResourceType,
} from '@medplum/fhirtypes';
import { AuthenticatedRequestContext, tryGetRequestContext } from '../context';
import type { Repository } from '../fhir/repo';
import { getProjectSystemRepo } from '../fhir/repo';
import { getLogger } from '../logger';
import type { AuditEventSubtype } from '../util/auditevent';
import {
  AuditEventOutcome,
  createAuditEvent,
  CreateInteraction,
  DeleteInteraction,
  logAuditEvent,
  OperationInteraction,
  RestfulOperationType,
  UpdateInteraction,
} from '../util/auditevent';
import type { EncounterReferences } from './signed-lock';
import {
  collectEncounterReferences,
  findNonLiteralEncounterLink,
  getAddendumTargets,
  getLinkedEncounterIds,
  isEncounterChildType,
  isLockableType,
  isLockEnabledProject,
  isSelfLocked,
  LOCK_OUTCOME_SYSTEM,
} from './signed-lock';

/** Resource types the guard looks at (everything else is untouched, even in an enabled project). */
const GUARDED_TYPES = new Set<string>([
  'Encounter',
  'Condition',
  'Procedure',
  'Observation',
  'ClinicalImpression',
  'QuestionnaireResponse',
  'DocumentReference',
  'Composition',
  'ProjectMembership',
  'Project',
  'AccessPolicy',
  'AuditEvent',
  'Binary',
]);

/**
 * Project fields a non-super-admin may not change in an enabled project. `features`, `link` and
 * `systemSetting` are already readonly for project admins upstream; they are listed again as defense in depth.
 */
export const PROTECTED_PROJECT_FIELDS = [
  'setting',
  'systemSetting',
  'systemSecret',
  'features',
  'checkReferencesOnWrite',
  'strictMode',
  'superAdmin',
  'link',
  'defaultAccessPolicies',
  'defaultPatientAccessPolicy',
] as const;

/** Reason codes (details.coding.code of the 403 OperationOutcome, system LOCK_OUTCOME_SYSTEM). */
export const LockReason = {
  SignedContent: 'signed-content-locked',
  SignedEncounter: 'encounter-signed',
  Expunge: 'expunge-forbidden',
  MembershipPolicyRequired: 'membership-policy-required',
  MembershipPolicyForeign: 'membership-policy-foreign',
  MembershipAdmin: 'membership-admin-forbidden',
  ProjectSettings: 'project-settings-locked',
  AccessPolicyAdmin: 'access-policy-super-admin-only',
  AuditImmutable: 'audit-immutable',
  EncounterReferenceInvalid: 'encounter-reference-invalid',
  BinaryImmutable: 'binary-immutable',
} as const;
export type LockReason = (typeof LockReason)[keyof typeof LockReason];

interface Denial {
  readonly code: LockReason;
  readonly message: string;
  /**
   * For a super admin: record the action as break-glass (signed clinical content, audit records, $expunge, the
   * lock flag itself). Routine super-admin configuration (AccessPolicies, memberships, other project fields,
   * e.g. by provisioning) is allowed without a break-glass record.
   */
  readonly breakGlass?: boolean;
}

type Actor = 'system' | 'superAdmin' | 'member';

function getActor(repo: Repository): Actor {
  if (!repo.isSuperAdmin()) {
    return 'member';
  }
  return repo.getConfig().author?.reference === 'system' ? 'system' : 'superAdmin';
}

/**
 * Builds the 403 OperationOutcome of a denial.
 * @param denial - The denial.
 * @returns OperationOutcome with id `forbidden` (HTTP 403) and the reason code.
 */
export function lockOutcome(denial: Denial): OperationOutcome {
  return {
    resourceType: 'OperationOutcome',
    id: 'forbidden',
    issue: [
      {
        severity: 'error',
        code: 'forbidden',
        details: {
          coding: [{ system: LOCK_OUTCOME_SYSTEM, code: denial.code }],
          text: `PracticeAI signed-content lock: ${denial.message}`,
        },
      },
    ],
  };
}

async function readProject(repo: Repository, projectId: string | undefined): Promise<Project | undefined> {
  if (!projectId) {
    return undefined;
  }
  const current = repo.currentProject();
  if (current?.id === projectId) {
    return current;
  }
  const systemRepo = await getProjectSystemRepo(projectId);
  try {
    return await systemRepo.readResource<Project>('Project', projectId);
  } catch {
    return undefined;
  } finally {
    systemRepo[Symbol.dispose]();
  }
}

/**
 * Reads resources by id as last COMMITTED, on a separate connection (not the caller's transaction), restricted
 * to one project. Using the committed state is deliberate: the signing transaction itself (Encounter PUT
 * finished + QuestionnaireResponse PUT completed + note POST) must still be able to write the encounter's
 * children, while any later transaction sees the encounter as signed.
 * @param resourceType - Resource type.
 * @param ids - Resource ids.
 * @param projectId - Only resources of this project are returned (other projects are "not resolvable").
 * @returns The resources found.
 */
async function readCommitted<T extends Resource>(
  resourceType: ResourceType,
  ids: string[],
  projectId: string
): Promise<T[]> {
  if (ids.length === 0) {
    return [];
  }
  const systemRepo = await getProjectSystemRepo(projectId);
  try {
    systemRepo.setMode(RepositoryMode.WRITER);
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const found = await systemRepo.searchResources<T>({
        resourceType: resourceType,
        filters: [{ code: '_id', operator: Operator.EQUALS, value: ids.slice(i, i + 100).join(',') }],
        count: 100,
      });
      out.push(...found.filter((r) => r.meta?.project === projectId));
    }
    return out;
  } finally {
    systemRepo[Symbol.dispose]();
  }
}

/** Max Encounters one logical (identifier) reference may match before the guard assumes a signed one. */
const MAX_IDENTIFIER_MATCHES = 1000;

/**
 * Resolves logical (identifier) Encounter references within the project, as last committed.
 * @param projectId - Project.
 * @param identifiers - Reference identifiers.
 * @returns The matching Encounters, or 'unresolvable' when an identifier cannot be searched safely
 * (search-syntax characters in it, or too many matches), in which case the caller must assume it is signed.
 */
async function resolveEncounterIdentifiers(
  projectId: string,
  identifiers: EncounterReferences['identifiers']
): Promise<Encounter[] | 'unresolvable'> {
  if (identifiers.length === 0) {
    return [];
  }
  const out: Encounter[] = [];
  const systemRepo = await getProjectSystemRepo(projectId);
  try {
    systemRepo.setMode(RepositoryMode.WRITER);
    for (const ident of identifiers) {
      if (/[|,$\\]/.test(ident.value) || (ident.system && /[|,$\\]/.test(ident.system))) {
        return 'unresolvable';
      }
      const found = await systemRepo.searchResources<Encounter>({
        resourceType: 'Encounter',
        filters: [
          { code: '_project', operator: Operator.EQUALS, value: projectId },
          {
            code: 'identifier',
            operator: Operator.EQUALS,
            value: ident.system ? `${ident.system}|${ident.value}` : ident.value,
          },
        ],
        count: MAX_IDENTIFIER_MATCHES,
      });
      if (found.length >= MAX_IDENTIFIER_MATCHES) {
        return 'unresolvable';
      }
      out.push(...found.filter((r) => r.meta?.project === projectId));
    }
    return out;
  } finally {
    systemRepo[Symbol.dispose]();
  }
}

/**
 * The signed Encounters of the project that `refs` designate: literal ids read as last committed, plus
 * logical (identifier) references resolved by business identifier.
 * @param projectId - Project.
 * @param refs - Encounter references collected from the resource(s).
 * @returns Locked encounter ids; `['<unresolvable identifier>']` when a logical reference cannot be resolved.
 */
async function findLockedEncounterIds(projectId: string, refs: EncounterReferences): Promise<string[]> {
  const encounters = await readCommitted<Encounter>('Encounter', refs.ids, projectId);
  const byIdentifier = await resolveEncounterIdentifiers(projectId, refs.identifiers);
  if (byIdentifier === 'unresolvable') {
    return ['<unresolvable identifier>'];
  }
  const locked = [...encounters, ...byIdentifier].filter(isSelfLocked).map((e) => e.id as string);
  return [...new Set(locked)];
}

function mergeEncounterReferences(...all: (EncounterReferences | undefined)[]): EncounterReferences {
  const ids = new Set<string>();
  const identifiers = new Map<string, EncounterReferences['identifiers'][number]>();
  for (const refs of all) {
    refs?.ids.forEach((id) => ids.add(id));
    refs?.identifiers.forEach((i) => identifiers.set(`${i.system ?? ''}|${i.value}`, i));
  }
  return { ids: [...ids], identifiers: [...identifiers.values()] };
}

/**
 * True when `doc` is an addendum (AI-03) to a signed note of every one of the locked encounters.
 * @param projectId - Project.
 * @param doc - The DocumentReference being created.
 * @param lockedEncounterIds - The locked encounters it links to.
 * @returns True when the create is an allowed addendum.
 */
async function isAllowedAddendum(projectId: string, doc: Resource, lockedEncounterIds: string[]): Promise<boolean> {
  const targets = getAddendumTargets(doc);
  if (!targets?.length) {
    return false;
  }
  const found = await readCommitted<DocumentReference>('DocumentReference', targets, projectId);
  if (found.length !== targets.length || !found.every(isSelfLocked)) {
    return false;
  }
  const covered = new Set(found.flatMap(getLinkedEncounterIds));
  return lockedEncounterIds.every((id) => covered.has(id));
}

async function checkMembership(
  project: Project,
  membership: Partial<ProjectMembership>,
  existing: ProjectMembership | undefined
): Promise<Denial | undefined> {
  if (membership.admin === true && existing?.admin !== true) {
    return { code: LockReason.MembershipAdmin, message: 'only a super admin can grant ProjectMembership.admin' };
  }
  const policyRefs: Reference<AccessPolicy>[] = [];
  if (membership.accessPolicy?.reference) {
    policyRefs.push(membership.accessPolicy);
  }
  for (const access of membership.access ?? []) {
    if (access.policy?.reference) {
      policyRefs.push(access.policy);
    }
  }
  if (policyRefs.length === 0) {
    if (membership.active === false) {
      return undefined; // deactivating a legacy membership is always allowed
    }
    return {
      code: LockReason.MembershipPolicyRequired,
      message: 'every membership, client and bot in this project must have an AccessPolicy',
    };
  }
  const ids: string[] = [];
  for (const ref of policyRefs) {
    const m = /^AccessPolicy\/([A-Za-z0-9\-.]{1,64})$/.exec(ref.reference as string);
    if (!m) {
      return { code: LockReason.MembershipPolicyForeign, message: `invalid AccessPolicy reference ${ref.reference}` };
    }
    ids.push(m[1]);
  }
  const unique = [...new Set(ids)];
  const found = await readCommitted<AccessPolicy>('AccessPolicy', unique, project.id as string);
  if (found.length !== unique.length) {
    return {
      code: LockReason.MembershipPolicyForeign,
      message: 'membership AccessPolicy must exist in the same project',
    };
  }
  return undefined;
}

function checkProjectUpdate(existing: Project, result: Project): Denial | undefined {
  const changed = PROTECTED_PROJECT_FIELDS.filter(
    (f) => stringify(existing[f as keyof Project]) !== stringify(result[f as keyof Project])
  );
  if (changed.length > 0) {
    return {
      breakGlass: isLockEnabledProject(existing) !== isLockEnabledProject(result),
      code: LockReason.ProjectSettings,
      message: `only a super admin can change Project.${changed.join(', Project.')}`,
    };
  }
  return undefined;
}

function binaryDenial(ref: string, verb: string): Denial {
  return {
    breakGlass: true,
    code: LockReason.BinaryImmutable,
    message: `${ref} cannot be ${verb}: Binaries are write-once in this project (signed content references them by id)`,
  };
}

async function evaluateWrite(
  project: Project,
  existing: Resource | undefined,
  result: Resource
): Promise<Denial | undefined> {
  const type = result.resourceType;
  const ref = `${type}/${result.id}`;
  if (isLockableType(type)) {
    if (existing && isSelfLocked(existing)) {
      return { breakGlass: true, code: LockReason.SignedContent, message: `${ref} is signed and cannot be modified` };
    }
    if (isEncounterChildType(type)) {
      // Every Encounter reference in any element of the stored AND the candidate version (literal or logical).
      const refs = mergeEncounterReferences(
        existing ? collectEncounterReferences(existing) : undefined,
        collectEncounterReferences(result)
      );
      const locked = await findLockedEncounterIds(project.id as string, refs);
      const nonLiteral = findNonLiteralEncounterLink(result);
      if (locked.length > 0) {
        if (
          !existing &&
          !nonLiteral &&
          type === 'DocumentReference' &&
          (await isAllowedAddendum(project.id as string, result, locked))
        ) {
          return undefined;
        }
        return {
          breakGlass: true,
          code: LockReason.SignedEncounter,
          message: existing
            ? `${ref} belongs to signed Encounter/${locked[0]}`
            : `cannot add ${type} to signed Encounter/${locked[0]} (only an addendum DocumentReference that appends the signed note is allowed)`,
        };
      }
      if (nonLiteral) {
        return {
          code: LockReason.EncounterReferenceInvalid,
          message: `${type} encounter links must be literal Encounter/<id> references in this project (${nonLiteral})`,
        };
      }
    }
    return undefined;
  }
  switch (type) {
    case 'ProjectMembership':
      return checkMembership(project, result, existing as ProjectMembership | undefined);
    case 'Project':
      return existing ? checkProjectUpdate(existing as Project, result) : undefined;
    case 'AccessPolicy':
      return { code: LockReason.AccessPolicyAdmin, message: 'AccessPolicies are managed by the super admin only' };
    case 'AuditEvent':
      return existing
        ? { breakGlass: true, code: LockReason.AuditImmutable, message: 'AuditEvents cannot be modified' }
        : undefined;
    case 'Binary':
      // Attachments (a signed note's content) point at `Binary/<id>` WITHOUT a version, so overwriting a Binary
      // would silently change what signed content resolves to. Binaries are write-once in an enabled project.
      return existing ? binaryDenial(ref, 'modified') : undefined;
    default:
      return undefined;
  }
}

async function evaluateDelete(project: Project, resource: Resource): Promise<Denial | undefined> {
  const type = resource.resourceType;
  const ref = `${type}/${resource.id}`;
  if (isLockableType(type)) {
    if (isSelfLocked(resource)) {
      return { breakGlass: true, code: LockReason.SignedContent, message: `${ref} is signed and cannot be deleted` };
    }
    if (isEncounterChildType(type)) {
      const locked = await findLockedEncounterIds(project.id as string, collectEncounterReferences(resource));
      if (locked.length > 0) {
        return {
          breakGlass: true,
          code: LockReason.SignedEncounter,
          message: `${ref} belongs to signed Encounter/${locked[0]}`,
        };
      }
    }
    return undefined;
  }
  switch (type) {
    case 'Project':
      return { code: LockReason.ProjectSettings, message: 'only a super admin can delete the project' };
    case 'AccessPolicy':
      return { code: LockReason.AccessPolicyAdmin, message: 'AccessPolicies are managed by the super admin only' };
    case 'AuditEvent':
      return { breakGlass: true, code: LockReason.AuditImmutable, message: 'AuditEvents cannot be deleted' };
    case 'Binary':
      return binaryDenial(ref, 'deleted');
    default:
      return undefined;
  }
}

/**
 * Refuses the action for members; for a super admin records the break-glass action instead.
 * @param repo - Acting repository.
 * @param actor - Actor kind.
 * @param project - The enabled project.
 * @param denial - Why a member would be refused.
 * @param target - The resource or reference acted on.
 * @param subtype - AuditEvent subtype.
 */
async function enforce(
  repo: Repository,
  actor: Actor,
  project: Project,
  denial: Denial,
  target: Resource | Reference,
  subtype: AuditEventSubtype
): Promise<void> {
  if (actor === 'member') {
    throw new OperationOutcomeError(lockOutcome(denial));
  }
  if (actor === 'superAdmin' && denial.breakGlass) {
    await auditBreakGlass(repo, project, denial, target, subtype);
  }
}

async function auditBreakGlass(
  repo: Repository,
  project: Project,
  denial: Denial,
  target: Resource | Reference,
  subtype: AuditEventSubtype
): Promise<void> {
  const config = repo.getConfig();
  const description = `PRACTICEAI break-glass (${denial.code}): super admin allowed; ${denial.message}`;
  getLogger().warn('PRACTICEAI break-glass: super admin action on signed-content lock', {
    projectId: project.id,
    author: config.author?.reference,
    reason: denial.code,
    target: 'resourceType' in target ? `${target.resourceType}/${target.id}` : target.reference,
    interaction: subtype.code,
  });
  const auditEvent: AuditEvent = createAuditEvent(
    RestfulOperationType,
    subtype,
    project.id as string,
    config.author,
    config.remoteAddress,
    AuditEventOutcome.Success,
    {
      description,
      resource: target,
      entityDetail: [{ type: 'practiceai-lock-reason', valueString: denial.code }],
      client: config.client,
    }
  );
  auditEvent.purposeOfEvent = [
    {
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'BTG', display: 'break the glass' },
      ],
    },
  ];
  logAuditEvent(auditEvent);
  // After commit: a rolled-back write leaves only the log line, not an AuditEvent claiming it happened.
  await repo.postCommit(async () => {
    const systemRepo = await getProjectSystemRepo(project.id as string);
    try {
      await systemRepo.createResource<AuditEvent>(auditEvent);
    } catch (err) {
      getLogger().error('PRACTICEAI break-glass AuditEvent could not be saved', err as Error);
    } finally {
      systemRepo[Symbol.dispose]();
    }
  });
}

/**
 * Hook for Repository.updateResourceImpl (create, update, patch, conditional, batch/transaction entries,
 * GraphQL mutations). Called with the stored version and the candidate version, after AccessPolicy checks.
 * @param repo - The acting repository.
 * @param existing - Stored version (undefined on create).
 * @param result - Version about to be written.
 */
export async function practiceAiGuardWrite(
  repo: Repository,
  existing: Resource | undefined,
  result: Resource
): Promise<void> {
  if (!GUARDED_TYPES.has(result.resourceType)) {
    return;
  }
  const actor = getActor(repo);
  if (actor === 'system') {
    return;
  }
  let project: Project | undefined;
  if (result.resourceType === 'Project') {
    project = existing as Project | undefined; // the stored flag decides, not the candidate
  } else if (actor === 'member') {
    // Members can only write into their own project (Repository.canPerformInteraction).
    project = repo.currentProject();
  } else {
    project = await readProject(repo, existing?.meta?.project ?? result.meta?.project);
  }
  if (!project || !isLockEnabledProject(project)) {
    return;
  }
  const denial = await evaluateWrite(project, existing, result);
  if (denial) {
    await enforce(repo, actor, project, denial, result, existing ? UpdateInteraction : CreateInteraction);
  }
}

/**
 * Hook for the Binary `$presigned-url?upload=true` operation: an upload URL overwrites the Binary's CURRENT
 * version in storage directly (no new version), so it is treated exactly like an update of the Binary.
 * @param repo - The acting repository.
 * @param binary - The stored Binary (read with meta.project).
 * @param upload - The operation's `upload` parameter (read-only URLs are not affected).
 */
export async function practiceAiGuardBinaryUpload(
  repo: Repository,
  binary: Resource,
  upload: boolean | undefined
): Promise<void> {
  if (upload) {
    await practiceAiGuardWrite(repo, binary, binary);
  }
}

/**
 * Hook for Repository.deleteResource (incl. conditional delete, batch/transaction DELETE, GraphQL delete).
 * @param repo - The acting repository.
 * @param resource - The stored resource about to be deleted.
 */
export async function practiceAiGuardDelete(repo: Repository, resource: Resource): Promise<void> {
  if (!GUARDED_TYPES.has(resource.resourceType)) {
    return;
  }
  const actor = getActor(repo);
  if (actor === 'system') {
    return;
  }
  let project: Project | undefined;
  if (resource.resourceType === 'Project') {
    project = resource;
  } else if (actor === 'member') {
    project = repo.currentProject();
  } else {
    project = await readProject(repo, resource.meta?.project);
  }
  if (!project || !isLockEnabledProject(project)) {
    return;
  }
  const denial = await evaluateDelete(project, resource);
  if (denial) {
    await enforce(repo, actor, project, denial, resource, DeleteInteraction);
  }
}

/**
 * Hook for Repository.expungeResources and the $expunge handler. Members of an enabled project can never
 * expunge (the lock and the audit trail depend on history). A super admin expunging a Project or lockable /
 * audit resources of an enabled project is recorded as break-glass.
 * @param repo - The acting repository.
 * @param resourceType - Resource type being expunged.
 * @param ids - Resource ids.
 */
export async function practiceAiGuardExpunge(repo: Repository, resourceType: string, ids: string[]): Promise<void> {
  const actor = getActor(repo);
  if (actor === 'system' || ids.length === 0) {
    return;
  }
  const denial: Denial = {
    breakGlass: true,
    code: LockReason.Expunge,
    message: `$expunge is not allowed in a project with signed-content lock (${resourceType})`,
  };
  if (actor === 'member') {
    const project = repo.currentProject();
    if (isLockEnabledProject(project)) {
      throw new OperationOutcomeError(lockOutcome(denial));
    }
    return;
  }
  // Super admin: audit per affected enabled project.
  const byProject = new Map<string, string[]>();
  if (resourceType === 'Project') {
    for (const id of ids) {
      byProject.set(id, [id]);
    }
  } else if (isLockableType(resourceType) || resourceType === 'AuditEvent') {
    const systemRepo = repo.getSystemRepo(); // shares the caller's connection; not disposed here
    {
      for (let i = 0; i < ids.length; i += 100) {
        const found = await systemRepo.searchResources({
          resourceType: resourceType,
          filters: [{ code: '_id', operator: Operator.EQUALS, value: ids.slice(i, i + 100).join(',') }],
          count: 100,
        });
        for (const r of found) {
          const pid = r.meta?.project;
          if (pid) {
            byProject.set(pid, [...(byProject.get(pid) ?? []), r.id]);
          }
        }
      }
    }
  }
  for (const [projectId, projectIds] of byProject) {
    const project = await readProject(repo, projectId);
    if (project && isLockEnabledProject(project)) {
      await auditBreakGlass(
        repo,
        project,
        { ...denial, message: `${denial.message}: ${resourceType}/${projectIds.slice(0, 20).join(', ')}` },
        { reference: `${resourceType}/${projectIds[0]}` },
        OperationInteraction
      );
    }
  }
}

/**
 * Hook for server code that writes a ProjectMembership with the SYSTEM repository on behalf of a caller
 * (POST /admin/projects/:id/client, /bot, /invite, Bot/$init, SCIM). Must run before anything is written.
 * @param actorRepo - The caller's repository; when undefined, the authenticated request context's repository.
 * @param projectId - Target project id.
 * @param membership - The membership fields that will be written (accessPolicy/access/admin/active).
 */
export async function practiceAiGuardNewMembership(
  actorRepo: Repository | undefined,
  projectId: string | undefined,
  membership: Partial<ProjectMembership>
): Promise<void> {
  let repo = actorRepo;
  if (!repo) {
    const ctx = tryGetRequestContext();
    if (!(ctx instanceof AuthenticatedRequestContext)) {
      return; // no authenticated caller (system, seeding, unauthenticated registration)
    }
    repo = ctx.repo;
  }
  const actor = getActor(repo);
  if (actor === 'system') {
    return;
  }
  const project = await readProject(repo, projectId);
  if (!project || !isLockEnabledProject(project)) {
    return;
  }
  const denial = await checkMembership(project, membership, undefined);
  if (denial) {
    await enforce(repo, actor, project, denial, { reference: `Project/${project.id}` }, CreateInteraction);
  }
}
