// Provision a synthetic PT practice for live end-to-end testing of the billing app's
// MedplumFhirGateway (billing GAP-03) and for the docker-compose stack.
//
//   npx tsx packages/practiceai/scripts/provision-e2e.ts [--org <uuid>] [--out <file>] [--env-out <file>]
//       [--name <practice name>] [--gateway-base-url <url>] [--fresh]
//
// What it does (all data synthetic):
//  1. provisionPractice() (src/provisioning) as the super admin: project, practice Organization,
//     7 AccessPolicies, the "PracticeAI Billing Integration" client, one provider (the billing seed's
//     synthetic practitioner: NPI 1234567893, Pat Placeholder, PT) and a practice admin.
//  2. Sets random passwords for the provider and the practice admin (POST /admin/super/setpassword,
//     project-scoped users) so tests can log in as those human identities.
//     The practice admin then creates (once) the synthetic service Location, because the
//     integration policy keeps the practice directory read-only for the billing app.
//  3. Writes a fixture JSON (mode 0600, default .run/e2e-practice.json, gitignored):
//     { baseUrl, organizationId, projectId, practiceOrganizationRef, locationRef, MEDPLUM_PROJECTS, provider, admin }
//     and optionally a dotenv file with MEDPLUM_PROJECTS='<json>' (--env-out) for docker compose.
//
// Re-running with the same --org is idempotent: when the fixture file already holds a working
// integration secret for that org it is kept; otherwise the secret is rotated (--rotate-secret)
// because Medplum only returns a client secret once. --fresh ignores the stored fixture and
// provisions a new practice (random org UUID unless --org is given). Passwords are reset on every run.
//
// Env: MEDPLUM_BASE_URL (default http://localhost:8103/), MEDPLUM_ADMIN_CLIENT_ID /
// MEDPLUM_ADMIN_CLIENT_SECRET (default: .run/dev-client.json written by scripts/smoke.ts).
// Secrets are written only to the output files, never to stdout/stderr.
import { ClientStorage, MedplumClient, MemoryStorage } from '@medplum/core';
import type { Location } from '@medplum/fhirtypes';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { provisionPractice, toMedplumProjects } from '../src/provisioning';
import type { MedplumProjectEnv, ProvisionResult } from '../src/provisioning';

const here = dirname(fileURLToPath(import.meta.url));
const runDir = resolve(here, '..', '.run');

/** The billing app's synthetic practitioner (billing src/lib/fhir/seed.ts SYNTHETIC_PRACTICE.practitioner). */
export const E2E_PROVIDER = { npi: '1234567893', firstName: 'Pat', lastName: 'Placeholder', suffix: 'PT' } as const;

/** The billing app's synthetic service location (billing seed.ts SYNTHETIC_PRACTICE.location), keyed by identifier. */
export const E2E_LOCATION = {
  identifier: { system: 'https://practiceai.example/fhir/sid/location-id', value: 'synthetic-pt-main' },
  name: 'Example Test PT Clinic',
  line1: '1 Synthetic Way',
  city: 'Testville',
  state: 'CA',
  zip: '90000',
} as const;

export interface E2eIdentity {
  email: string;
  password: string;
  practitionerRef: string;
}

export interface E2ePracticeFixture {
  baseUrl: string;
  organizationId: string;
  projectId: string;
  practiceOrganizationRef: string | null;
  /** Service Location created by the practice admin (the integration policy keeps Location read-only). */
  locationRef: string;
  MEDPLUM_PROJECTS: Record<string, MedplumProjectEnv>;
  provider: E2eIdentity;
  admin: E2eIdentity;
  createdAt: string;
}

function log(message: string): void {
  process.stderr.write(`[provision-e2e] ${message}\n`);
}

function adminCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.MEDPLUM_ADMIN_CLIENT_ID;
  const clientSecret = process.env.MEDPLUM_ADMIN_CLIENT_SECRET;
  if (clientId && clientSecret) {return { clientId, clientSecret };}
  const file = resolve(runDir, 'dev-client.json');
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { clientId?: string; clientSecret?: string };
    if (saved.clientId && saved.clientSecret) {return { clientId: saved.clientId, clientSecret: saved.clientSecret };}
  }
  throw new Error('need MEDPLUM_ADMIN_CLIENT_ID/MEDPLUM_ADMIN_CLIENT_SECRET or .run/dev-client.json (run scripts/smoke.ts)');
}

async function canLogin(baseUrl: string, entry: MedplumProjectEnv | undefined): Promise<boolean> {
  if (!entry) {return false;}
  try {
    const c = new MedplumClient({ baseUrl, fetch });
    await c.startClientLogin(entry.clientId, entry.clientSecret);
    return c.getActiveLogin()?.project.reference === `Project/${entry.projectId}`;
  } catch {
    return false;
  }
}

function newPassword(): string {
  // Random, never in a breach corpus (the server checks HIBP on setpassword).
  return `Syn-${randomBytes(18).toString('base64url')}`;
}

async function passwordLogin(baseUrl: string, email: string, password: string, projectId: string): Promise<MedplumClient> {
  const storage = new ClientStorage(new MemoryStorage());
  const verifier = randomBytes(48).toString('base64url');
  storage.setString('codeVerifier', verifier);
  const client = new MedplumClient({ baseUrl, fetch, storage });
  const login = await client.startLogin({
    email,
    password,
    projectId,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    codeChallengeMethod: 'S256',
  });
  if (!login.code) {
    throw new Error(`password login for ${email} returned no code`);
  }
  await client.processCode(login.code);
  return client;
}

/**
 * Idempotently create the synthetic service Location as the practice admin (If-None-Exist on its identifier).
 * @param practiceAdmin - Client logged in as the practice admin (Practice Admin policy).
 * @param practiceOrganizationRef - The practice Organization that manages the location.
 * @returns The Location reference.
 */
async function ensureLocation(practiceAdmin: MedplumClient, practiceOrganizationRef: string | null): Promise<string> {
  const l = E2E_LOCATION;
  const location = await practiceAdmin.createResourceIfNoneExist<Location>(
    {
      resourceType: 'Location',
      status: 'active',
      identifier: [{ ...l.identifier }],
      name: l.name,
      address: { line: [l.line1], city: l.city, state: l.state, postalCode: l.zip },
      ...(practiceOrganizationRef ? { managingOrganization: { reference: practiceOrganizationRef } } : {}),
    },
    `identifier=${l.identifier.system}|${l.identifier.value}`
  );
  return `Location/${location.id}`;
}

async function setPassword(admin: MedplumClient, email: string, password: string, projectId: string): Promise<void> {
  await admin.post(admin.getBaseUrl() + 'admin/super/setpassword', { email, password, projectId });
}

export async function provisionE2ePractice(opts: {
  baseUrl: string;
  organizationId: string;
  name?: string;
  gatewayBaseUrl?: string;
  previous?: E2ePracticeFixture | null;
}): Promise<E2ePracticeFixture> {
  const admin = new MedplumClient({ baseUrl: opts.baseUrl, fetch });
  const creds = adminCredentials();
  await admin.startClientLogin(creds.clientId, creds.clientSecret);
  const tag = opts.organizationId.slice(0, 8);
  const providerEmail = `pat.placeholder+${tag}@synthetic-pt.example`;
  const adminEmail = `practice-admin+${tag}@synthetic-pt.example`;
  const input = {
    practiceName: opts.name ?? `Example Test PT Clinic ${tag}`,
    organizationId: opts.organizationId,
    adminEmail,
    adminFirstName: 'Practice',
    adminLastName: 'Admin',
    groupNpi: '1245319599',
    providers: [{ ...E2E_PROVIDER, email: providerEmail }],
  };
  const gatewayBaseUrl = opts.gatewayBaseUrl ?? opts.baseUrl;
  let result: ProvisionResult = await provisionPractice(admin, input, { baseUrl: gatewayBaseUrl, onAction: (a) => log(`${a.step}: ${a.status}${a.reference ? ` ${a.reference}` : ''}`) });
  let entry = result.integration.clientSecret ? toMedplumProjects(result, { revealSecret: true })[opts.organizationId] : undefined;
  if (!entry) {
    const prior = opts.previous?.organizationId === opts.organizationId ? opts.previous.MEDPLUM_PROJECTS[opts.organizationId] : undefined;
    if (prior?.clientId === result.integration.clientId && (await canLogin(opts.baseUrl, prior))) {
      log('keeping the integration secret from the existing fixture (still valid)');
      entry = { ...prior, baseUrl: gatewayBaseUrl };
    } else {
      log('no usable stored secret for this practice: rotating the integration secret');
      result = await provisionPractice(admin, input, { baseUrl: gatewayBaseUrl, rotateIntegrationSecret: true });
      entry = toMedplumProjects(result, { revealSecret: true })[opts.organizationId];
    }
  }
  if (!entry || !result.projectId) {throw new Error('provisioning did not produce a MEDPLUM_PROJECTS entry');}
  const providerId = result.providers[0]?.practitionerId;
  if (!providerId || !result.admin.practitionerId) {throw new Error('provider/admin Practitioner missing after provisioning');}

  const providerPassword = newPassword();
  const adminPassword = newPassword();
  await setPassword(admin, providerEmail, providerPassword, result.projectId);
  await setPassword(admin, adminEmail, adminPassword, result.projectId);
  log(`passwords set for the provider and practice admin (project ${result.projectId})`);
  const practiceOrganizationRef = result.practiceOrganizationId ? `Organization/${result.practiceOrganizationId}` : null;
  const locationRef = await ensureLocation(await passwordLogin(opts.baseUrl, adminEmail, adminPassword, result.projectId), practiceOrganizationRef);
  log(`service location ${locationRef} (created or found by the practice admin)`);
  if (!(await canLogin(opts.baseUrl, entry))) {throw new Error('integration client cannot log in to its project');}

  return {
    baseUrl: opts.baseUrl,
    organizationId: opts.organizationId,
    projectId: result.projectId,
    practiceOrganizationRef,
    locationRef,
    MEDPLUM_PROJECTS: { [opts.organizationId]: entry },
    provider: { email: providerEmail, password: providerPassword, practitionerRef: `Practitioner/${providerId}` },
    admin: { email: adminEmail, password: adminPassword, practitionerRef: `Practitioner/${result.admin.practitionerId}` },
    createdAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      org: { type: 'string' },
      out: { type: 'string' },
      'env-out': { type: 'string' },
      name: { type: 'string' },
      'gateway-base-url': { type: 'string' },
      fresh: { type: 'boolean', default: false },
    },
  });
  const baseUrl = (process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/').replace(/\/?$/, '/');
  const out = resolve(values.out ?? resolve(runDir, 'e2e-practice.json'));
  const previous: E2ePracticeFixture | null = !values.fresh && existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as E2ePracticeFixture) : null;
  const organizationId = values.org ?? (values.fresh ? undefined : previous?.organizationId) ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {throw new Error('--org must be a UUID');}
  const gatewayBaseUrl = values['gateway-base-url'] ?? process.env.MEDPLUM_GATEWAY_BASE_URL;
  const fixture = await provisionE2ePractice({
    baseUrl,
    organizationId,
    ...(values.name ? { name: values.name } : {}),
    ...(gatewayBaseUrl ? { gatewayBaseUrl: gatewayBaseUrl.replace(/\/?$/, '/') } : {}),
    previous,
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 });
  log(`fixture written to ${out} (contains secrets; gitignored under .run/)`);
  if (values['env-out']) {
    const envOut = resolve(values['env-out']);
    mkdirSync(dirname(envOut), { recursive: true });
    writeFileSync(
      envOut,
      `# Generated by packages/practiceai/scripts/provision-e2e.ts at ${fixture.createdAt}. Synthetic practice. Contains a secret: do not commit.\n` +
        // Single-quoted so the file works both as a compose env_file and when sourced by sh (JSON has no single quotes).
        `MEDPLUM_PROJECTS='${JSON.stringify(fixture.MEDPLUM_PROJECTS)}'\n` +
        `MEDPLUM_ORGANIZATION_ID=${fixture.organizationId}\n`,
      { mode: 0o600 },
    );
    log(`MEDPLUM_PROJECTS written to ${envOut}`);
  }
  // stdout: non-secret summary only.
  process.stdout.write(
    JSON.stringify({ organizationId, projectId: fixture.projectId, provider: fixture.provider.practitionerRef, fixture: out }, null, 2) + '\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`[provision-e2e] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
