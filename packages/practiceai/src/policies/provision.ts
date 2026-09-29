// Provisioning helpers: install the role AccessPolicies into a practice project and create
// role identities. Intended to run as the platform's operations identity (a super admin, or a
// short-lived provisioning client) — never as a day-to-day identity.

import type { MedplumClient } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { AccessPolicy, ClientApplication, Project, ProjectMembership } from '@medplum/fhirtypes';
import type { PracticeRole } from './constants';
import { PRACTICE_ROLES } from './constants';
import type { PracticePolicyOptions } from './roles';
import { buildRolePolicy } from './roles';

export type PracticePolicyIds = Record<PracticeRole, AccessPolicy & { id: string }>;

/**
 * Creates or updates (by name, within the project) every PracticeAI role AccessPolicy.
 * Idempotent. Requires a super-admin client (writes into another project via meta.project).
 * @param medplum - A MedplumClient authenticated as a super admin (operations identity).
 * @param options - Optional settings.
 * @returns The saved AccessPolicy per role.
 */
export async function upsertPracticePolicies(
  medplum: MedplumClient,
  options: PracticePolicyOptions
): Promise<PracticePolicyIds> {
  const out = {} as PracticePolicyIds;
  for (const role of PRACTICE_ROLES) {
    const desired = buildRolePolicy(role, options);
    // name:exact: the plain `name` search is a case-insensitive prefix match.
    const existing = await medplum.searchOne('AccessPolicy', {
      'name:exact': desired.name as string,
      _project: options.projectId,
    });
    let saved: AccessPolicy;
    if (existing) {
      saved = await medplum.updateResource({ ...desired, id: existing.id, meta: { ...desired.meta } });
    } else {
      saved = await medplum.createResource(desired);
    }
    out[role] = saved as AccessPolicy & { id: string };
  }
  return out;
}

/**
 * Project features every practice project needs.
 * 'transaction-bundles': without it Medplum processes `transaction` Bundles with batch semantics
 * (entries commit individually even when another entry is rejected). The billing app's
 * signEncounter / note autosave rely on atomic transactions. Project admins cannot change
 * `features` (readonly for them); only a super admin can.
 */
export const REQUIRED_PROJECT_FEATURES: NonNullable<Project['features']> = ['transaction-bundles'];

/**
 * Creates a practice project (super admin only).
 * @param medplum - A MedplumClient authenticated as a super admin (operations identity).
 * @param name - Display name.
 * @returns The created Project.
 */
export async function createPracticeProject(medplum: MedplumClient, name: string): Promise<Project & { id: string }> {
  const project = await medplum.createResource<Project>({
    resourceType: 'Project',
    name,
    features: [...REQUIRED_PROJECT_FEATURES],
    // Keep history (default) — signed-note reconstruction depends on _history.
  });
  return project;
}

export interface RoleUserInput {
  readonly projectId: string;
  readonly policy: AccessPolicy & { id: string };
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly password?: string;
}

/**
 * Invites a human user with a Practitioner profile into the practice project, bound to one role policy.
 * Always `admin: false` (project admins bypass policies via $expunge / membership edits).
 * @param medplum - A MedplumClient authenticated as a super admin (operations identity).
 * @param input - The user to invite and the role policy to bind.
 * @returns The created ProjectMembership.
 */
export async function inviteRoleUser(medplum: MedplumClient, input: RoleUserInput): Promise<ProjectMembership> {
  return medplum.post(medplum.getBaseUrl() + `admin/projects/${input.projectId}/invite`, {
    resourceType: 'Practitioner',
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    password: input.password,
    scope: 'project',
    sendEmail: false,
    membership: { accessPolicy: createReference(input.policy), admin: false },
  });
}

/**
 * Creates a ClientApplication in the practice project bound to one role policy
 * (used for ai_service and the billing platform integration client).
 * @param medplum - A MedplumClient authenticated as a super admin (operations identity).
 * @param projectId - The practice project id.
 * @param policy - The role AccessPolicy.
 * @param name - Display name.
 * @returns The ClientApplication, including its secret.
 */
export async function createRoleClient(
  medplum: MedplumClient,
  projectId: string,
  policy: AccessPolicy & { id: string },
  name: string
): Promise<ClientApplication & { id: string; secret: string }> {
  return medplum.post(medplum.getBaseUrl() + `admin/projects/${projectId}/client`, {
    name,
    description: `PracticeAI ${name}`,
    accessPolicy: createReference(policy),
  });
}
