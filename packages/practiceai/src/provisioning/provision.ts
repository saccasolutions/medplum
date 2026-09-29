/**
 * Practice provisioning (plan §6.1: one Medplum project per practice).
 *
 * provisionPractice() converges a practice to the desired state; every step
 * looks the resource up first by a stable key and only creates or updates
 * what differs, so re-running it is safe and returns the same ids:
 *
 *   Project                    identifier  <sid/organization-id>|<billing org UUID>   (super admin search)
 *   Organization               identifier  <sid/organization-id>|<billing org UUID>   (in the project)
 *   AccessPolicy (per role)    name:exact  from the policies module                   (in the project)
 *   ClientApplication x2       name:exact  "PracticeAI Billing Integration" / "PracticeAI AI Service"
 *   Practitioner (providers)   identifier  http://hl7.org/fhir/sid/us-npi|<NPI>
 *   Practitioner (admin)       identifier  <sid/provisioned-user>|practice-admin:<email>
 *   ProjectMembership          project + profile (users) / project + user (clients)
 *   Content                    url + version                                           (conditional create)
 *
 * All writes are made by a super admin with meta.project set to the practice
 * project, so every resource lives inside that practice's project.
 *
 * The integration client's secret is returned once (OneTimeSecret, redacted
 * in logs/JSON) when the client is created or rotated, and never logged.
 */
import type {
  AccessPolicy,
  ClientApplication,
  Identifier,
  Organization,
  Practitioner,
  Project,
  ProjectMembership,
  Reference,
  Resource,
  ResourceType,
} from '@medplum/fhirtypes';
import { randomBytes } from 'node:crypto';
import { ptContentResources } from '../content';
import { EXT, PROVISIONING_SYSTEMS, SYSTEMS } from '../content/constants';
import { REQUIRED_PROJECT_FEATURES, buildPracticePolicies, mergeSystemSettings } from '../policies';
import { OneTimeSecret } from './secret';
import type {
  AdminClient,
  ProviderInput,
  ProvisionAction,
  ProvisionOptions,
  ProvisionPracticeInput,
  ProvisionResult,
  ProvisionStatus,
  RolePolicyBuilder,
} from './types';
import { normalizeProvisionInput } from './validate';

export const INTEGRATION_CLIENT_NAME = 'PracticeAI Billing Integration';
export const AI_SERVICE_CLIENT_NAME = 'PracticeAI AI Service';
export const DEFAULT_PT_TAXONOMY = '225100000X';

/** Roles bound by provisioning (policies module role names). */
export const BOUND_ROLES = {
  practiceAdmin: 'practice_admin',
  provider: 'provider',
  integration: 'integration',
  aiService: 'ai_service',
} as const;

export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

// ------------------------------------------------------------------ helpers

type WithId<T> = T & { id: string };

function ref<T extends Resource>(r: WithId<T>): Reference<T> {
  return { reference: `${r.resourceType}/${r.id}` } as Reference<T>;
}

function refString(r: { resourceType: string; id?: string }): string {
  return `${r.resourceType}/${r.id ?? '(new)'}`;
}

/** Stable JSON of the given fields (sorted keys, undefined dropped). */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

function sameFields<T extends object>(a: T, b: T, fields: readonly (keyof T)[]): boolean {
  return fields.every((f) => canonical(a[f] ?? null) === canonical(b[f] ?? null));
}

/** Existing identifiers plus any desired ones (same system+value) that are missing. */
export function mergeIdentifiers(existing: Identifier[] | undefined, desired: Identifier[]): Identifier[] {
  const out = [...(existing ?? [])];
  for (const d of desired) {
    if (!out.some((e) => e.system === d.system && e.value === d.value)) out.push(d);
  }
  return out;
}

function newSecret(): string {
  return randomBytes(32).toString('hex');
}

// --------------------------------------------------------------- resource builders

export function buildProject(input: ProvisionPracticeInput): Project {
  return {
    resourceType: 'Project',
    name: input.practiceName,
    description: `PracticeAI practice project (billing organization ${input.organizationId})`,
    identifier: [{ system: PROVISIONING_SYSTEMS.organizationId, value: input.organizationId }],
    strictMode: true,
    // 'transaction-bundles': without it Medplum runs `transaction` Bundles with batch semantics, so the
    // billing app's sign / autosave transactions would partially commit when one entry is refused.
    features: [...REQUIRED_PROJECT_FEATURES],
    // 'practiceai-signed-lock': server-side signed-content guard (only a super admin can set/clear it).
    systemSetting: mergeSystemSettings(undefined),
  };
}

/** Existing project features plus the required ones (order kept, no duplicates). */
export function mergeFeatures(existing: Project['features']): NonNullable<Project['features']> {
  const out = [...(existing ?? [])];
  for (const f of REQUIRED_PROJECT_FEATURES) {
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

export function buildPracticeOrganization(input: ProvisionPracticeInput, projectId: string): Organization {
  const identifier: Identifier[] = [{ system: PROVISIONING_SYSTEMS.organizationId, value: input.organizationId }];
  if (input.groupNpi) identifier.push({ system: SYSTEMS.npi, value: input.groupNpi });
  return {
    resourceType: 'Organization',
    meta: { project: projectId },
    active: true,
    name: input.practiceName,
    identifier,
    type: [{ coding: [{ system: SYSTEMS.organizationType, code: 'prov', display: 'Healthcare Provider' }] }],
    extension: [{ url: EXT.taxonomy, valueCoding: { system: SYSTEMS.taxonomy, code: input.taxonomy ?? DEFAULT_PT_TAXONOMY } }],
  };
}

export function buildProviderPractitioner(p: ProviderInput, projectId: string): Practitioner {
  return {
    resourceType: 'Practitioner',
    meta: { project: projectId },
    active: true,
    name: [{ use: 'official', given: [p.firstName], family: p.lastName, ...(p.suffix ? { suffix: [p.suffix] } : {}) }],
    identifier: [{ system: SYSTEMS.npi, value: p.npi }],
    ...(p.email ? { telecom: [{ system: 'email', use: 'work', value: p.email }] } : {}),
    qualification: [{ code: { coding: [{ system: SYSTEMS.taxonomy, code: p.taxonomy ?? DEFAULT_PT_TAXONOMY }] } }],
  };
}

export function adminUserKey(email: string): string {
  return `practice-admin:${email.toLowerCase()}`;
}

export function buildAdminPractitioner(input: ProvisionPracticeInput, projectId: string): Practitioner {
  return {
    resourceType: 'Practitioner',
    meta: { project: projectId },
    active: true,
    name: [{ given: [input.adminFirstName ?? 'Practice'], family: input.adminLastName ?? 'Admin' }],
    identifier: [{ system: PROVISIONING_SYSTEMS.provisionedUser, value: adminUserKey(input.adminEmail) }],
    telecom: [{ system: 'email', use: 'work', value: input.adminEmail }],
  };
}

// ------------------------------------------------------------------ provisioner

class Provisioner {
  readonly actions: ProvisionAction[] = [];
  readonly admin: AdminClient;
  readonly options: ProvisionOptions;
  readonly dryRun: boolean;

  constructor(admin: AdminClient, options: ProvisionOptions) {
    this.admin = admin;
    this.options = options;
    this.dryRun = options.dryRun === true;
  }

  record(step: string, status: ProvisionStatus, reference?: string, detail?: string): void {
    const action: ProvisionAction = { step, status, ...(reference ? { reference } : {}), ...(detail ? { detail } : {}) };
    this.actions.push(action);
    this.options.onAction?.(action);
  }

  async findAll<T extends Resource>(type: ResourceType, query: Record<string, string>): Promise<WithId<T>[]> {
    return [...(await this.admin.searchResources(type, { ...query, _count: '20' }, { cache: 'no-cache' }))] as unknown as WithId<T>[];
  }

  async findOne<T extends Resource>(step: string, type: ResourceType, query: Record<string, string>): Promise<WithId<T> | undefined> {
    const found = await this.findAll<T>(type, query);
    if (found.length > 1) {
      throw new ProvisioningError(`${step}: ${found.length} ${type} resources match ${JSON.stringify(query)}; resolve the duplicates manually`);
    }
    return found[0];
  }

  /** Create when missing, update when the compared fields differ. */
  async converge<T extends Resource>(
    step: string,
    existing: WithId<T> | undefined,
    desired: T,
    fields: readonly (keyof T)[],
    merge: (existing: WithId<T>) => WithId<T> = (e) => ({ ...e, ...pick(desired, fields) }),
  ): Promise<WithId<T> | undefined> {
    if (!existing) {
      if (this.dryRun) {
        this.record(step, 'would-create', desired.resourceType);
        return undefined;
      }
      const created = (await this.admin.createResource(desired)) as WithId<T>;
      this.record(step, 'created', refString(created));
      return created;
    }
    const next = merge(existing);
    if (sameFields(existing, next, fields)) {
      this.record(step, 'unchanged', refString(existing));
      return existing;
    }
    if (this.dryRun) {
      this.record(step, 'would-update', refString(existing));
      return existing;
    }
    const updated = (await this.admin.updateResource(next)) as WithId<T>;
    this.record(step, 'updated', refString(updated));
    return updated;
  }
}

function pick<T extends object>(obj: T, fields: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

/** Membership bound to exactly one policy; `admin` is left absent (not false) when it already is. */
function desiredMembership(existing: WithId<ProjectMembership>, policy: WithId<AccessPolicy>, admin: boolean): WithId<ProjectMembership> {
  const { access: _access, admin: _admin, ...rest } = existing;
  return { ...rest, accessPolicy: ref(policy), ...(admin || existing.admin !== undefined ? { admin } : {}) };
}

async function ensureSuperAdmin(admin: AdminClient): Promise<void> {
  const project = admin.getProject?.();
  if (project && project.superAdmin !== true) {
    throw new ProvisioningError('provisioning requires credentials in the Medplum Super Admin project');
  }
}

/**
 * Provision (or converge) one practice. See the module comment for the keys
 * that make it idempotent. Throws ProvisioningInputError for bad input and
 * ProvisioningError when existing state is ambiguous.
 */
export async function provisionPractice(
  admin: AdminClient,
  rawInput: ProvisionPracticeInput,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const input = normalizeProvisionInput(rawInput);
  await ensureSuperAdmin(admin);
  const p = new Provisioner(admin, options);
  const policyBuilder: RolePolicyBuilder = options.policies ?? ((projectId) => buildPracticePolicies({ projectId }));
  const result: ProvisionResult = {
    organizationId: input.organizationId,
    dryRun: p.dryRun,
    projectId: null,
    practiceOrganizationId: null,
    accessPolicies: {},
    integration: { clientId: null, clientSecret: null },
    aiService: { clientId: null },
    admin: { email: input.adminEmail, practitionerId: null, membershipId: null },
    providers: (input.providers ?? []).map((pr) => ({ npi: pr.npi, practitionerId: null, membershipId: null })),
    content: [],
    baseUrl: options.baseUrl ?? admin.getBaseUrl(),
    actions: p.actions,
  };
  const orgKey = `${PROVISIONING_SYSTEMS.organizationId}|${input.organizationId}`;

  // 1. Project (one per practice).
  const existingProject = await p.findOne<Project>('project', 'Project', { identifier: orgKey });
  const projectDesired = buildProject(input);
  const project = await p.converge<Project>('project', existingProject, projectDesired, ['name', 'identifier', 'features', 'systemSetting'], (e) => ({
    ...e,
    name: projectDesired.name,
    identifier: mergeIdentifiers(e.identifier, projectDesired.identifier ?? []),
    features: mergeFeatures(e.features),
    systemSetting: mergeSystemSettings(e.systemSetting),
  }));
  if (!project) {
    // Dry run of a brand-new practice: everything downstream would be created.
    for (const step of ['organization', 'access-policies', 'integration-client', 'ai-service-client', 'practice-admin', 'providers', 'content']) {
      p.record(step, 'would-create');
    }
    return result;
  }
  const projectId = project.id;
  result.projectId = projectId;
  const inProject = { _project: projectId };

  // 2. Practice Organization.
  const orgDesired = buildPracticeOrganization(input, projectId);
  const org = await p.converge<Organization>(
    'organization',
    await p.findOne<Organization>('organization', 'Organization', { identifier: orgKey, ...inProject }),
    orgDesired,
    ['name', 'active', 'identifier'],
    (e) => ({ ...e, name: orgDesired.name, active: true, identifier: mergeIdentifiers(e.identifier, orgDesired.identifier ?? []) }),
  );
  result.practiceOrganizationId = org?.id ?? null;

  // 3. AccessPolicies from the policies module.
  const policies = policyBuilder(projectId);
  for (const role of Object.values(BOUND_ROLES)) {
    if (!policies[role]) throw new ProvisioningError(`policies module did not return a policy for role "${role}"`);
  }
  const policyIds: Record<string, WithId<AccessPolicy> | undefined> = {};
  for (const [role, policy] of Object.entries(policies)) {
    if (!policy.name) throw new ProvisioningError(`policy for role "${role}" has no name`);
    const desired: AccessPolicy = { ...policy, meta: { ...policy.meta, project: projectId } };
    const existing = await p.findOne<AccessPolicy>(`access-policy:${role}`, 'AccessPolicy', { 'name:exact': policy.name, ...inProject });
    const saved = await p.converge<AccessPolicy>(`access-policy:${role}`, existing, desired, ['name', 'resource', 'compartment', 'basedOn', 'ipAccessRule', 'extension'], (e) => ({
      ...desired,
      id: e.id,
      meta: e.meta,
    }));
    policyIds[role] = saved;
    result.accessPolicies[role] = saved?.id ?? null;
  }

  // 4. ClientApplications (billing integration, AI service) bound to their policies.
  const ensureClient = async (step: string, name: string, description: string, role: string, rotate: boolean) => {
    const policy = policyIds[role];
    const existing = await p.findOne<ClientApplication>(step, 'ClientApplication', { 'name:exact': name, ...inProject });
    if (!existing) {
      if (p.dryRun || !policy) {
        p.record(step, 'would-create', 'ClientApplication');
        return { clientId: null, secret: null };
      }
      const created = await admin.post<ClientApplication>(`admin/projects/${projectId}/client`, {
        name,
        description,
        accessPolicy: ref(policy),
      });
      if (!created.id || !created.secret) throw new ProvisioningError(`${step}: server did not return the new client`);
      p.record(step, 'created', refString(created), `bound to AccessPolicy/${policy.id}`);
      return { clientId: created.id, secret: new OneTimeSecret(created.secret) };
    }
    p.record(step, 'unchanged', refString(existing));
    // Converge the membership's policy binding.
    const membership = await p.findOne<ProjectMembership>(`${step}:membership`, 'ProjectMembership', {
      project: `Project/${projectId}`,
      user: `ClientApplication/${existing.id}`,
    });
    if (!membership) {
      // The server's POST /admin/projects/:id/client writes the ClientApplication and its membership as two
      // separate, non-transactional writes, and a provisioning run can also die right after the client was
      // created. Either way the client never logged in (login requires a membership) and its secret was never
      // delivered, so repair the membership and issue a fresh secret.
      if (p.dryRun || !policy) {
        p.record(`${step}:membership`, 'would-create', 'ProjectMembership', 'repair: client has no membership');
        return { clientId: existing.id, secret: null };
      }
      const repaired = (await admin.createResource<ProjectMembership>({
        resourceType: 'ProjectMembership',
        meta: { project: projectId },
        project: { reference: `Project/${projectId}` },
        user: { reference: `ClientApplication/${existing.id}` },
        profile: { reference: `ClientApplication/${existing.id}` },
        accessPolicy: ref(policy),
      })) as WithId<ProjectMembership>;
      p.record(`${step}:membership`, 'created', refString(repaired), 'repaired: client had no membership (interrupted creation)');
      const value = newSecret();
      await admin.updateResource<ClientApplication>({ ...existing, secret: value });
      p.record(`${step}:secret`, 'updated', refString(existing), 'new secret issued: the original was never delivered');
      return { clientId: existing.id, secret: new OneTimeSecret(value) };
    }
    if (policy) {
      await p.converge<ProjectMembership>(`${step}:membership`, membership, desiredMembership(membership, policy, false), ['accessPolicy', 'access', 'admin']);
    }
    let secret: OneTimeSecret | null = null;
    if (rotate) {
      if (p.dryRun) p.record(`${step}:secret`, 'would-update', refString(existing));
      else {
        const value = newSecret();
        await admin.updateResource<ClientApplication>({ ...existing, secret: value, retiringSecret: existing.secret });
        secret = new OneTimeSecret(value);
        p.record(`${step}:secret`, 'updated', refString(existing), 'secret rotated; previous secret kept as retiringSecret');
      }
    }
    return { clientId: existing.id, secret };
  };
  const integration = await ensureClient(
    'integration-client',
    INTEGRATION_CLIENT_NAME,
    `Billing/RCM platform server for organization ${input.organizationId} (MedplumFhirGateway)`,
    BOUND_ROLES.integration,
    options.rotateIntegrationSecret === true,
  );
  result.integration = { clientId: integration.clientId, clientSecret: integration.secret };
  // The AI service secret is not returned: issue it via rotation in the Medplum admin UI when needed.
  const ai = await ensureClient('ai-service-client', AI_SERVICE_CLIENT_NAME, 'AI service identity (whitelisted workflow/claim writes only)', BOUND_ROLES.aiService, false);
  result.aiService = { clientId: ai.clientId };

  // 5. Users: practice admin + providers.
  const ensureMembership = async (
    step: string,
    profile: WithId<Practitioner> | undefined,
    person: { email: string; firstName: string; lastName: string },
    role: string,
    isAdmin: boolean,
  ): Promise<string | null> => {
    const policy = policyIds[role];
    if (!profile || !policy) {
      p.record(step, 'would-create', 'ProjectMembership');
      return null;
    }
    const existing = await p.findOne<ProjectMembership>(step, 'ProjectMembership', { project: `Project/${projectId}`, profile: `Practitioner/${profile.id}` });
    if (existing) {
      const saved = await p.converge<ProjectMembership>(step, existing, desiredMembership(existing, policy, isAdmin), ['accessPolicy', 'access', 'admin']);
      return saved?.id ?? existing.id;
    }
    if (p.dryRun) {
      p.record(step, 'would-create', 'ProjectMembership');
      return null;
    }
    const membership = (await admin.post(`admin/projects/${projectId}/invite`, {
      resourceType: 'Practitioner',
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      scope: options.userScope ?? 'project',
      sendEmail: options.sendInviteEmails === true,
      membership: { profile: ref(profile), accessPolicy: ref(policy), admin: isAdmin },
    })) as ProjectMembership;
    p.record(step, 'created', refString(membership), `invited ${role}`);
    return membership.id ?? null;
  };

  const adminDesired = buildAdminPractitioner(input, projectId);
  const adminPractitioner = await p.converge<Practitioner>(
    'practice-admin:practitioner',
    await p.findOne<Practitioner>('practice-admin:practitioner', 'Practitioner', {
      identifier: `${PROVISIONING_SYSTEMS.provisionedUser}|${adminUserKey(input.adminEmail)}`,
      ...inProject,
    }),
    adminDesired,
    ['active', 'identifier'],
    (e) => ({ ...e, active: true, identifier: mergeIdentifiers(e.identifier, adminDesired.identifier ?? []) }),
  );
  result.admin.practitionerId = adminPractitioner?.id ?? null;
  result.admin.membershipId = await ensureMembership(
    'practice-admin:membership',
    adminPractitioner,
    { email: input.adminEmail, firstName: input.adminFirstName ?? 'Practice', lastName: input.adminLastName ?? 'Admin' },
    BOUND_ROLES.practiceAdmin,
    // Never a Medplum project admin: project admins bypass AccessPolicies (see policies/roles.ts).
    false,
  );

  for (const [i, provider] of (input.providers ?? []).entries()) {
    const desired = buildProviderPractitioner(provider, projectId);
    const step = `provider:${provider.npi}`;
    const practitioner = await p.converge<Practitioner>(
      `${step}:practitioner`,
      await p.findOne<Practitioner>(step, 'Practitioner', { identifier: `${SYSTEMS.npi}|${provider.npi}`, ...inProject }),
      desired,
      ['active', 'identifier', 'name'],
      (e) => ({ ...e, active: true, name: desired.name, identifier: mergeIdentifiers(e.identifier, desired.identifier ?? []) }),
    );
    const entry = result.providers[i];
    if (entry) {
      entry.practitionerId = practitioner?.id ?? null;
      if (provider.email) {
        entry.membershipId = await ensureMembership(
          `${step}:membership`,
          practitioner,
          { email: provider.email, firstName: provider.firstName, lastName: provider.lastName },
          BOUND_ROLES.provider,
          false,
        );
      }
    }
  }

  // 6. PT content (conditional create by url + version, inside the project).
  if (options.loadContent !== false) {
    for (const resource of ptContentResources()) {
      const step = `content:${resource.resourceType}:${resource.url}|${resource.version}`;
      const query = { url: resource.url, version: resource.version, ...inProject };
      const existing = await p.findOne<Resource>(step, resource.resourceType, query);
      if (existing) {
        p.record(step, 'unchanged', refString(existing));
        result.content.push({ reference: refString(existing), url: resource.url, version: resource.version });
        continue;
      }
      if (p.dryRun) {
        p.record(step, 'would-create', resource.resourceType);
        result.content.push({ reference: null, url: resource.url, version: resource.version });
        continue;
      }
      const created = await admin.createResourceIfNoneExist(
        { ...resource, meta: { project: projectId } },
        new URLSearchParams(query).toString(),
      );
      p.record(step, 'created', refString(created));
      result.content.push({ reference: refString(created), url: resource.url, version: resource.version });
    }
  }

  return result;
}
