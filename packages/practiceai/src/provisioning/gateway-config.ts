/**
 * MEDPLUM_PROJECTS output for the billing app.
 *
 * Shape (billing src/lib/server/config.ts medplumProjectsSchema and
 * src/lib/fhir/medplum-gateway.ts MedplumProjectConfig):
 *
 *   { "<organization UUID>": { "projectId": "...", "clientId": "...", "clientSecret": "...", "baseUrl"?: "..." } }
 */
import type { MedplumProjectEnv, ProvisionResult } from './types';

/** Placeholder written when this run did not issue the secret (it was returned once, earlier). */
export const SECRET_NOT_REISSUED = '<unchanged: use the secret issued when this client was created, or rerun with --rotate-secret>';

export interface GatewayEntryOptions {
  /** Include the real one-time secret (only when this run issued it). Default false: redacted. */
  revealSecret?: boolean;
}

/**
 * Build the MEDPLUM_PROJECTS map for a provisioning result. With
 * revealSecret the entry carries the freshly issued secret; otherwise (or
 * when no secret was issued this run) clientSecret is a placeholder that will
 * fail login instead of silently working.
 */
export function toMedplumProjects(result: ProvisionResult, options: GatewayEntryOptions = {}): Record<string, MedplumProjectEnv> {
  if (!result.projectId || !result.integration.clientId) {
    throw new Error('practice is not provisioned (dry run?): no projectId/clientId');
  }
  const secret = result.integration.clientSecret;
  const clientSecret = secret ? (options.revealSecret ? secret.reveal() : secret.toString()) : SECRET_NOT_REISSUED;
  return {
    [result.organizationId]: {
      projectId: result.projectId,
      clientId: result.integration.clientId,
      clientSecret,
      baseUrl: result.baseUrl,
    },
  };
}

/** Merge one practice entry into an existing MEDPLUM_PROJECTS JSON value (string or object). */
export function mergeMedplumProjects(
  existing: string | Record<string, MedplumProjectEnv> | undefined,
  entry: Record<string, MedplumProjectEnv>,
): Record<string, MedplumProjectEnv> {
  const base: Record<string, MedplumProjectEnv> = typeof existing === 'string' ? (existing.trim() ? JSON.parse(existing) : {}) : { ...(existing ?? {}) };
  for (const [orgId, value] of Object.entries(entry)) {
    const prior = base[orgId];
    // Keep a previously configured secret when this run did not issue a new one.
    base[orgId] = prior && value.clientSecret === SECRET_NOT_REISSUED && prior.clientId === value.clientId ? { ...value, clientSecret: prior.clientSecret } : value;
  }
  return base;
}
