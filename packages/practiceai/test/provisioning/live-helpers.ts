/**
 * Helpers for *.live.test.ts: tests that run against a REAL Medplum server
 * when MEDPLUM_BASE_URL is set (e.g. the dev server from scripts/dev-up.sh).
 *
 * Super admin credentials: MEDPLUM_ADMIN_CLIENT_ID / MEDPLUM_ADMIN_CLIENT_SECRET,
 * or (local dev) the client saved by scripts/smoke.ts in .run/dev-client.json.
 * All data created is synthetic.
 */
import { MedplumClient } from '@medplum/core';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIVE_BASE_URL = process.env.MEDPLUM_BASE_URL;
export const LIVE = Boolean(LIVE_BASE_URL);

function adminCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.MEDPLUM_ADMIN_CLIENT_ID;
  const clientSecret = process.env.MEDPLUM_ADMIN_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.run', 'dev-client.json');
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { clientId?: string; clientSecret?: string };
    if (saved.clientId && saved.clientSecret) return { clientId: saved.clientId, clientSecret: saved.clientSecret };
  }
  throw new Error('live tests need MEDPLUM_ADMIN_CLIENT_ID/MEDPLUM_ADMIN_CLIENT_SECRET or .run/dev-client.json (run scripts/smoke.ts)');
}

export function newClient(): MedplumClient {
  return new MedplumClient({ baseUrl: LIVE_BASE_URL, fetch });
}

export async function superAdminClient(): Promise<MedplumClient> {
  const { clientId, clientSecret } = adminCredentials();
  const client = newClient();
  await client.startClientLogin(clientId, clientSecret);
  if (client.getProject()?.superAdmin !== true) throw new Error('live admin credentials are not in the Super Admin project');
  return client;
}

export async function clientLogin(clientId: string, clientSecret: string): Promise<MedplumClient> {
  const client = newClient();
  await client.startClientLogin(clientId, clientSecret);
  return client;
}

/** Resolves to the HTTP status of a failed call (or 0 if it succeeded). */
export async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (err) {
    const outcome = (err as { outcome?: { issue?: { code?: string }[] } }).outcome;
    const code = outcome?.issue?.[0]?.code;
    if (code === 'not-found') return 404;
    if (code === 'forbidden') return 403;
    if (code === 'conflict') return 409;
    if (code === 'processing' || code === 'invalid') return 400;
    return -1;
  }
}
