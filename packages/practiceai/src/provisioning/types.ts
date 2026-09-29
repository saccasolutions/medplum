import type { MedplumClient } from '@medplum/core';
import type { AccessPolicy } from '@medplum/fhirtypes';
import type { OneTimeSecret } from './secret';

/**
 * The MedplumClient surface provisioning uses. Must be authenticated as a
 * member of the Medplum Super Admin project (client credentials of a super
 * admin ClientApplication, or a super admin user login).
 */
export type AdminClient = Pick<
  MedplumClient,
  'searchResources' | 'createResource' | 'createResourceIfNoneExist' | 'updateResource' | 'readResource' | 'post' | 'getBaseUrl'
> &
  Partial<Pick<MedplumClient, 'getProject'>>;

export interface ProviderInput {
  /** 10-digit NPI (check digit validated). Keys the Practitioner inside the project. */
  npi: string;
  firstName: string;
  lastName: string;
  /** When present, the provider is invited as a project user with the Provider policy. */
  email?: string;
  /** Credential suffix, e.g. "PT", "DPT". */
  suffix?: string;
  /** NUCC taxonomy code (default 225100000X Physical Therapist). */
  taxonomy?: string;
}

export interface ProvisionPracticeInput {
  practiceName: string;
  /** Billing-app organization UUID (the MEDPLUM_PROJECTS key). */
  organizationId: string;
  adminEmail: string;
  adminFirstName?: string;
  adminLastName?: string;
  providers?: ProviderInput[];
  /** Group (type 2) NPI of the practice, optional. */
  groupNpi?: string;
  /** Practice NUCC taxonomy (default 225100000X). */
  taxonomy?: string;
}

/** Role name -> AccessPolicy (the policies module's buildRolePolicies). */
export type RolePolicyBuilder = (projectId: string) => Record<string, AccessPolicy>;

export interface ProvisionOptions {
  /** Base URL written into the MEDPLUM_PROJECTS entry (default: the admin client's base URL). */
  baseUrl?: string;
  /** Read-only: report what would change, write nothing. */
  dryRun?: boolean;
  /** Issue a new integration client secret (the old one stays valid as retiringSecret). */
  rotateIntegrationSecret?: boolean;
  /** Send Medplum invite e-mails (default false: set passwords via the reset flow later). */
  sendInviteEmails?: boolean;
  /** Scope of invited users (default 'project': one login per practice, no cross-project users). */
  userScope?: 'project' | 'server';
  /** Override the AccessPolicy builder (default: ../policies buildRolePolicies). */
  policies?: RolePolicyBuilder;
  /** Load the PT content (default true). */
  loadContent?: boolean;
  /** Receives each action as it happens. Actions never contain secrets. */
  onAction?: (action: ProvisionAction) => void;
}

export type ProvisionStatus = 'created' | 'updated' | 'unchanged' | 'would-create' | 'would-update';

export interface ProvisionAction {
  step: string;
  status: ProvisionStatus;
  /** "Type/id" when known. */
  reference?: string;
  detail?: string;
}

export interface ProvisionedProvider {
  npi: string;
  practitionerId: string | null;
  membershipId: string | null;
}

/** One MEDPLUM_PROJECTS entry (billing src/lib/server/config.ts MedplumProjectEnv). */
export interface MedplumProjectEnv {
  projectId: string;
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
}

export interface ProvisionResult {
  organizationId: string;
  dryRun: boolean;
  projectId: string | null;
  practiceOrganizationId: string | null;
  /** Role -> AccessPolicy id. */
  accessPolicies: Record<string, string | null>;
  integration: {
    clientId: string | null;
    /** Present only when a secret was issued by this run (new client or rotation). Redacted in JSON/inspect. */
    clientSecret: OneTimeSecret | null;
  };
  aiService: { clientId: string | null };
  admin: { email: string; practitionerId: string | null; membershipId: string | null };
  providers: ProvisionedProvider[];
  content: { reference: string | null; url: string; version: string }[];
  baseUrl: string;
  actions: ProvisionAction[];
}
