// Live-server harness for the PracticeAI AccessPolicy tests.
// Talks to a REAL running Medplum server (MEDPLUM_BASE_URL). All data is synthetic.

import type { WithId } from '@medplum/core';
import { ClientStorage, MedplumClient, MemoryStorage } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';
import { createHash, randomBytes } from 'node:crypto';
import { SIGNED_LOCK_OUTCOME_SYSTEM } from '../../src/policies/constants';

export const BASE_URL = (process.env.MEDPLUM_BASE_URL ?? '').replace(/\/?$/, '/');
export const LIVE = Boolean(process.env.MEDPLUM_BASE_URL);
export const ADMIN_EMAIL = process.env.MEDPLUM_ADMIN_EMAIL ?? 'admin@example.com';
export const ADMIN_PASSWORD = process.env.MEDPLUM_ADMIN_PASSWORD ?? 'medplum_admin';

/**
 * Password login via the PKCE authorization-code flow (POST /auth/login, then /oauth2/token).
 * @param email - Login email.
 * @param password - Login password.
 * @param projectId - The practice project id.
 * @returns The result of passwordLogin.
 */
export async function passwordLogin(email: string, password: string, projectId?: string): Promise<MedplumClient> {
  const storage = new ClientStorage(new MemoryStorage());
  const codeVerifier = randomBytes(48).toString('base64url');
  storage.setString('codeVerifier', codeVerifier);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const client = new MedplumClient({ baseUrl: BASE_URL, fetch, storage });
  const login = await client.startLogin({ email, password, projectId, codeChallenge, codeChallengeMethod: 'S256' });
  if (!login.code) {
    throw new Error(`Login for ${email} did not return a code: ${JSON.stringify(login)}`);
  }
  await client.processCode(login.code);
  return client;
}

export async function clientLogin(clientId: string, clientSecret: string): Promise<MedplumClient> {
  const client = new MedplumClient({ baseUrl: BASE_URL, fetch });
  await client.startClientLogin(clientId, clientSecret);
  return client;
}

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

/** An identity acting over raw HTTP so the tests assert the real status codes. */
export class Actor {
  readonly name: string;
  readonly client: MedplumClient;

  constructor(name: string, client: MedplumClient) {
    this.name = name;
    this.client = client;
  }

  private get token(): string {
    const t = this.client.getAccessToken();
    if (!t) {
      throw new Error(`${this.name} has no access token`);
    }
    return t;
  }

  async request<T = any>(method: string, path: string, body?: unknown, contentType?: string): Promise<HttpResult<T>> {
    let url = BASE_URL + 'fhir/R4/' + path;
    if (path.startsWith('http')) {
      url = path;
    } else if (path.startsWith('admin/')) {
      url = BASE_URL + path;
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/fhir+json',
        ...(body !== undefined ? { 'Content-Type': contentType ?? 'application/fhir+json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T };
  }

  get<T = any>(path: string): Promise<HttpResult<T>> {
    return this.request<T>('GET', path);
  }

  create<T extends Resource>(resource: T): Promise<HttpResult<WithId<T>>> {
    return this.request<WithId<T>>('POST', resource.resourceType, resource);
  }

  update<T extends Resource>(resource: T): Promise<HttpResult<WithId<T>>> {
    return this.request<WithId<T>>('PUT', `${resource.resourceType}/${resource.id}`, resource);
  }

  patch<T = any>(path: string, ops: unknown[]): Promise<HttpResult<T>> {
    return this.request<T>('PATCH', path, ops, 'application/json-patch+json');
  }

  delete(path: string): Promise<HttpResult> {
    return this.request('DELETE', path);
  }

  transaction(entries: unknown[]): Promise<HttpResult> {
    return this.request('POST', '', { resourceType: 'Bundle', type: 'transaction', entry: entries });
  }
}

/**
 * Short description of a failed HTTP result for assertion messages.
 * @param r - The HTTP result.
 * @returns The result of describe_.
 */
export function describe_(r: HttpResult): string {
  const issue = r.body?.issue?.[0];
  return `${r.status} ${issue ? `${issue.code}: ${issue.details?.text ?? issue.diagnostics ?? ''}` : ''}`;
}

export function runId(): string {
  return `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

export function expectStatus(r: HttpResult, expected: number | number[], what: string): void {
  const list = Array.isArray(expected) ? expected : [expected];
  if (!list.includes(r.status)) {
    throw new Error(`${what}: expected HTTP ${list.join('|')}, got ${describe_(r)}`);
  }
}

/**
 * Allowed: any 2xx.
 * @param r - The HTTP result.
 * @param what - Description of the operation, used in the failure message.
 */
export function expectAllowed(r: HttpResult, what: string): void {
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`${what}: expected 2xx, got ${describe_(r)}`);
  }
}

/**
 * Denied by policy: 403 Forbidden.
 * @param r - The HTTP result.
 * @param what - Description of the operation, used in the failure message.
 */
export function expectForbidden(r: HttpResult, what: string): void {
  expectStatus(r, 403, what);
}

/**
 * Denied by the fork's server-side signed-content guard (packages/server/src/practiceai/guard.ts): 403 whose
 * OperationOutcome carries the guard's reason code.
 * @param r - The HTTP result.
 * @param reason - Expected reason code (SIGNED_LOCK_REASONS value).
 * @param what - Description of the operation, used in the failure message.
 */
export function expectLockDenied(r: HttpResult, reason: string, what: string): void {
  expectStatus(r, 403, what);
  const coding = r.body?.issue?.[0]?.details?.coding?.[0];
  if (coding?.system !== SIGNED_LOCK_OUTCOME_SYSTEM || coding?.code !== reason) {
    throw new Error(`${what}: expected guard reason ${reason}, got ${JSON.stringify(r.body?.issue?.[0])}`);
  }
}
