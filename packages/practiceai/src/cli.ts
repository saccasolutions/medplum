/**
 * PracticeAI Medplum CLI.
 *
 *   npx tsx packages/practiceai/src/cli.ts provision --name "Synthetic PT Clinic" \
 *       --org 3b0f6f0e-8a57-4a39-9a55-2f2d8d5d0c11 --admin-email admin@synthetic-pt.example \
 *       [--provider 'npi=1234567893,first=Pat,last=Synthetic,email=pat@synthetic-pt.example,suffix=DPT'] \
 *       [--providers-file providers.json] [--group-npi 1234567893] \
 *       [--dry-run] [--rotate-secret] [--send-invites] [--user-scope project|server] [--no-content]
 *
 *   npx tsx packages/practiceai/src/cli.ts content      # print the PT content resources as a Bundle
 *
 * Environment:
 *   MEDPLUM_BASE_URL             Medplum server (default http://localhost:8103/)
 *   MEDPLUM_ADMIN_CLIENT_ID      ClientApplication in the Super Admin project
 *   MEDPLUM_ADMIN_CLIENT_SECRET
 *   MEDPLUM_GATEWAY_BASE_URL     baseUrl written into the MEDPLUM_PROJECTS entry (default MEDPLUM_BASE_URL)
 *
 * Output: progress (never secrets) on stderr; one JSON document on stdout:
 *   { "result": {...}, "MEDPLUM_PROJECTS": { "<org>": { projectId, clientId, clientSecret, baseUrl } } }
 * clientSecret is the real one-time integration secret ONLY when this run created or rotated the
 * client; store it in the secret manager immediately, it cannot be displayed again.
 */
import { MedplumClient } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ptContentResources } from './content';
import { SECRET_NOT_REISSUED, toMedplumProjects } from './provisioning/gateway-config';
import { provisionPractice } from './provisioning/provision';
import type { ProviderInput } from './provisioning/types';
import { ProvisioningInputError } from './provisioning/validate';

const USAGE = `usage:
  cli.ts provision --name <practice name> --org <billing org UUID> --admin-email <email>
                   [--admin-first <name>] [--admin-last <name>] [--group-npi <npi>]
                   [--provider 'npi=..,first=..,last=..[,email=..][,suffix=..][,taxonomy=..]']...
                   [--providers-file <json array>] [--dry-run] [--rotate-secret] [--send-invites]
                   [--user-scope project|server] [--no-content]
  cli.ts content
env: MEDPLUM_BASE_URL, MEDPLUM_ADMIN_CLIENT_ID, MEDPLUM_ADMIN_CLIENT_SECRET[, MEDPLUM_GATEWAY_BASE_URL]`;

export function parseProviderSpec(spec: string): ProviderInput {
  const fields: Record<string, string> = {};
  for (const part of spec.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) throw new ProvisioningInputError([`--provider: expected key=value, got "${part}"`]);
    fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const { npi, first, last, email, suffix, taxonomy } = fields;
  if (!npi || !first || !last) throw new ProvisioningInputError(['--provider needs npi, first and last']);
  return { npi, firstName: first, lastName: last, ...(email ? { email } : {}), ...(suffix ? { suffix } : {}), ...(taxonomy ? { taxonomy } : {}) };
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function provisionCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      org: { type: 'string' },
      'admin-email': { type: 'string' },
      'admin-first': { type: 'string' },
      'admin-last': { type: 'string' },
      'group-npi': { type: 'string' },
      provider: { type: 'string', multiple: true },
      'providers-file': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'rotate-secret': { type: 'boolean', default: false },
      'send-invites': { type: 'boolean', default: false },
      'user-scope': { type: 'string' },
      'no-content': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.name || !values.org || !values['admin-email']) {
    log(USAGE);
    return 2;
  }
  const userScope = values['user-scope'];
  if (userScope !== undefined && userScope !== 'project' && userScope !== 'server') {
    log('--user-scope must be project or server');
    return 2;
  }
  const providers: ProviderInput[] = [...(values.provider ?? []).map(parseProviderSpec)];
  if (values['providers-file']) {
    const parsed: unknown = JSON.parse(readFileSync(values['providers-file'], 'utf8'));
    if (!Array.isArray(parsed)) throw new ProvisioningInputError(['--providers-file must contain a JSON array']);
    providers.push(...(parsed as ProviderInput[]));
  }

  const baseUrl = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/';
  const clientId = process.env.MEDPLUM_ADMIN_CLIENT_ID;
  const clientSecret = process.env.MEDPLUM_ADMIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    log('MEDPLUM_ADMIN_CLIENT_ID and MEDPLUM_ADMIN_CLIENT_SECRET (Super Admin project client) are required');
    return 2;
  }
  const admin = new MedplumClient({ baseUrl, fetch });
  await admin.startClientLogin(clientId, clientSecret);
  log(`connected to ${admin.getBaseUrl()} as super admin client ${clientId}${values['dry-run'] ? ' (dry run: no writes)' : ''}`);

  const result = await provisionPractice(
    admin,
    {
      practiceName: values.name,
      organizationId: values.org,
      adminEmail: values['admin-email'],
      ...(values['admin-first'] ? { adminFirstName: values['admin-first'] } : {}),
      ...(values['admin-last'] ? { adminLastName: values['admin-last'] } : {}),
      ...(values['group-npi'] ? { groupNpi: values['group-npi'] } : {}),
      providers,
    },
    {
      dryRun: values['dry-run'],
      rotateIntegrationSecret: values['rotate-secret'],
      sendInviteEmails: values['send-invites'],
      ...(userScope ? { userScope } : {}),
      loadContent: !values['no-content'],
      baseUrl: process.env.MEDPLUM_GATEWAY_BASE_URL ?? admin.getBaseUrl(),
      onAction: (a) => log(`  ${a.status.padEnd(12)} ${a.step}${a.reference ? ` ${a.reference}` : ''}${a.detail ? ` (${a.detail})` : ''}`),
    },
  );

  const output: Record<string, unknown> = { result };
  if (!result.dryRun) {
    const issued = result.integration.clientSecret !== null;
    output.MEDPLUM_PROJECTS = toMedplumProjects(result, { revealSecret: issued });
    if (issued) {
      const warning =
        'MEDPLUM_PROJECTS below contains the ONE-TIME integration client secret. Store it in the secret manager now (never commit it); it will not be shown again. Rerun with --rotate-secret to issue a new one.';
      output.warning = warning;
      log(`\nWARNING: ${warning}\n`);
    } else {
      log(`\nNo new secret issued (client already existed). clientSecret is a placeholder: "${SECRET_NOT_REISSUED}"`);
    }
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

function contentCommand(): number {
  const bundle: Bundle = {
    resourceType: 'Bundle',
    type: 'collection',
    entry: ptContentResources().map((resource) => ({ fullUrl: `${resource.url}|${resource.version}`, resource })),
  };
  process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'provision') return await provisionCommand(rest);
    if (command === 'content') return contentCommand();
    log(USAGE);
    return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
  } catch (err) {
    if (err instanceof ProvisioningInputError) {
      log(err.message);
      return 2;
    }
    // Error messages from Medplum are OperationOutcome diagnostics (no secrets).
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && /cli\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      log(String(err));
      process.exit(1);
    },
  );
}
