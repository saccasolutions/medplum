/**
 * Smoke test against a running local Medplum server (started by scripts/dev-up.sh).
 *
 *  1. GET /healthcheck
 *  2. Password login (PKCE authorization-code flow) as the seeded dev super admin
 *  3. Create + read a synthetic Patient via the FHIR API
 *  4. Ensure a dev ClientApplication exists in the super admin project, then
 *     obtain a token via OAuth client_credentials and create another Patient with it.
 *     Client id/secret are written to .run/dev-client.json (gitignored).
 *
 * Usage: npx tsx scripts/smoke.ts   (env: MEDPLUM_BASE_URL, MEDPLUM_ADMIN_EMAIL, MEDPLUM_ADMIN_PASSWORD)
 * All data is synthetic.
 */
import { ClientStorage, MedplumClient, MemoryStorage } from '@medplum/core';
import type { ClientApplication, Patient } from '@medplum/fhirtypes';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseUrl = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/';
const email = process.env.MEDPLUM_ADMIN_EMAIL ?? 'admin@example.com';
const password = process.env.MEDPLUM_ADMIN_PASSWORD ?? 'medplum_admin';
const runDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.run');
const CLIENT_NAME = 'PracticeAI Dev Smoke Client';

function syntheticPatient(tag: string): Patient {
  return {
    resourceType: 'Patient',
    active: true,
    name: [{ given: ['Synthetic'], family: `Smoketest-${tag}` }],
    birthDate: '1980-01-01',
    gender: 'unknown',
    identifier: [{ system: 'urn:practiceai:synthetic', value: `${tag}-${Date.now()}` }],
  };
}

async function main(): Promise<void> {
  const health = await fetch(new URL('healthcheck', baseUrl)).then((r) => r.json());
  console.log('healthcheck:', JSON.stringify(health));

  // --- password (PKCE) login ---
  // PKCE S256 computed with node:crypto (MedplumClient's browser-oriented helper would fall back to 'plain').
  const storage = new ClientStorage(new MemoryStorage());
  const codeVerifier = randomBytes(48).toString('base64url');
  storage.setString('codeVerifier', codeVerifier);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const admin = new MedplumClient({ baseUrl, fetch, storage });
  const login = await admin.startLogin({ email, password, codeChallenge, codeChallengeMethod: 'S256' });
  if (!login.code) {
    throw new Error('Login did not return a code (multiple memberships?): ' + JSON.stringify(login));
  }
  await admin.processCode(login.code);
  const project = admin.getProject();
  console.log(`logged in as ${email}; project=${project?.name} (${project?.id}) superAdmin=${project?.superAdmin}`);

  const p1 = await admin.createResource(syntheticPatient('password-flow'));
  const p1read = await admin.readResource('Patient', p1.id as string);
  console.log(`created+read Patient/${p1read.id} (password flow)`);

  // --- client credentials ---
  let client: ClientApplication | undefined = await admin.searchOne('ClientApplication', { name: CLIENT_NAME });
  if (!client) {
    client = await admin.post<ClientApplication>(new URL(`admin/projects/${project?.id}/client`, baseUrl).toString(), {
      name: CLIENT_NAME,
      description: 'Local dev smoke-test client (synthetic data only)',
    });
    console.log(`created ClientApplication/${client.id}`);
  }
  const cc = new MedplumClient({ baseUrl, fetch });
  await cc.startClientLogin(client.id as string, client.secret as string);
  const p2 = await cc.createResource(syntheticPatient('client-credentials'));
  console.log(`created Patient/${p2.id} (client_credentials flow)`);

  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    resolve(runDir, 'dev-client.json'),
    JSON.stringify({ baseUrl, projectId: project?.id, clientId: client.id, clientSecret: client.secret }, null, 2) + '\n',
    { mode: 0o600 }
  );
  console.log(`client credentials written to ${resolve(runDir, 'dev-client.json')}`);
  console.log('SMOKE OK');
}

main().catch((err) => {
  console.error('SMOKE FAILED', err);
  process.exit(1);
});
