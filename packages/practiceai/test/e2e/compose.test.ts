// Static checks of docker-compose.practiceai.yml through `docker compose config` (no daemon needed).
// Skipped when the docker CLI with the compose plugin is not installed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO = resolve(__dirname, '..', '..', '..', '..');
const FILE = resolve(REPO, 'docker-compose.practiceai.yml');

function compose(args: string[]): string {
  return execFileSync('docker', ['compose', '-f', FILE, ...args], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let hasCompose = false;
try {
  execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  hasCompose = true;
} catch {
  hasCompose = false;
}

interface ComposeService {
  profiles?: string[];
  image?: string;
  build?: { context?: string; dockerfile?: string; dockerfile_inline?: string; additional_contexts?: Record<string, string> };
  environment?: Record<string, string | null>;
  depends_on?: Record<string, { condition?: string }>;
  volumes?: { source?: string; target?: string; read_only?: boolean }[];
}
interface ComposeModel {
  services: Record<string, ComposeService>;
}

describe.skipIf(!hasCompose)('docker-compose.practiceai.yml', () => {
  test('default mode: only the backing services (dev-up.sh MEDPLUM_SKIP_LOCAL_SERVICES=1 path)', () => {
    const model = JSON.parse(compose(['config', '--format', 'json'])) as ComposeModel;
    expect(Object.keys(model.services).sort()).toEqual(['postgres', 'redis']);
  });

  test('stack profile: fork-built server/app, provisioning job, billing wired with FHIR_MODE=medplum', () => {
    const model = JSON.parse(compose(['--profile', 'stack', 'config', '--format', 'json'])) as ComposeModel;
    const s = model.services;
    expect(Object.keys(s).sort()).toEqual(['billing', 'medplum-app', 'medplum-server', 'postgres', 'practiceai-provision', 'redis']);
    // Built from this fork with the upstream Dockerfiles.
    expect(s['medplum-server']?.build?.context).toBe(REPO);
    expect(s['medplum-server']?.build?.dockerfile).toBe('Dockerfile');
    expect(s['medplum-app']?.build?.context).toBe(resolve(REPO, 'packages/app'));
    // Billing: Medplum mode, credentials only from the provisioning job's shared volume.
    const billing = s.billing;
    expect(billing?.environment?.FHIR_MODE).toBe('medplum');
    expect(billing?.environment?.MEDPLUM_BASE_URL).toBe('http://medplum-server:8103/');
    expect(billing?.environment?.MEDPLUM_PROJECTS).toBeUndefined();
    expect(billing?.environment?.SEED_DEMO).toBe('false');
    expect(billing?.environment?.APP_ENV).toBe('development');
    // billing refuses demo auth with FHIR_MODE=medplum; the stack defaults to Supabase auth
    expect(billing?.environment?.AUTH_MODE).toBe('supabase');
    expect(billing?.environment?.STORE_MODE).toBe('supabase');
    expect(billing?.depends_on?.['practiceai-provision']?.condition).toBe('service_completed_successfully');
    expect(billing?.volumes?.find((v) => v.target === '/shared')?.read_only).toBe(true);
    expect(billing?.build?.dockerfile_inline).toContain('/shared/medplum-projects.env');
    expect(s['practiceai-provision']?.depends_on?.['medplum-server']?.condition).toBe('service_healthy');
    expect(s['practiceai-provision']?.build?.additional_contexts?.['practiceai-src']).toBe(resolve(REPO, 'packages/practiceai/src'));
  });

  test('no secrets committed: no client secrets or tokens in the compose file or .env.example', () => {
    for (const f of [FILE, resolve(REPO, 'packages/practiceai/.env.example')]) {
      const text = readFileSync(f, 'utf8');
      expect(text).not.toMatch(/clientSecret"\s*:\s*"[^"<]/);
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/); // JWT
      expect(text).not.toMatch(/MEDPLUM_PROJECTS=\S/);
    }
  });
});
