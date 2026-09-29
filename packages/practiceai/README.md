# @practiceai/medplum-setup

Fork-local tooling that turns this Medplum fork (`saccasolutions/medplum`, upstream `medplum/medplum`)
into the clinical/FHIR platform of the **Independent PracticeAI RCM Platform**. The companion
billing/RCM app lives in a separate repo (`/home/user/billing`, Next.js); it reaches this server
through its `MedplumFhirGateway` (`src/lib/fhir/medplum-gateway.ts`).

Everything PracticeAI-specific lives in this package, `docker-compose.practiceai.yml` at the repo root, and
the server guard in `packages/server/src/practiceai/` (new files) wired in by 14 one-line imports and hook calls marked
`// PRACTICEAI:`, so upstream merges stay clean (see [Fork maintenance](#fork-maintenance)). Nothing is rebranded yet.

> **HIPAA: synthetic data only.** No PHI may enter any environment built from this package until
> BAAs, account configuration, access controls, logging, encryption, backup/restore and the
> vendor-specific HIPAA requirements are complete (billing `docs/product-plan.txt` §5, §6.1
> "preview and test environments use synthetic data only"). All scripts, seeds and tests here create
> obviously fake people, NPIs and identifiers, and the dev credentials below are public dev defaults.

## How this package maps to the plan

| Plan requirement (billing `docs/product-plan.txt`) | Where it is implemented | Verified by |
| --- | --- | --- |
| §5.1 Medplum owns chart, encounter status, patient/coverage/provider, signed documentation, FHIR Claim/ClaimResponse, clinical audit/history | Stock Medplum server (resource history kept) + billing `MedplumFhirGateway` | billing `tests/medplum-live` (live) |
| §6.1 one Medplum project per practice | `src/provisioning` (`provisionPractice`, CLI `src/cli.ts`) | `test/provisioning/*.live.test.ts`, billing `tests/medplum-live` |
| §6.1 roles Provider / Biller / RCM Supervisor / Practice Admin / Front Office / AI Service + billing integration client, with explicit limitations | `src/policies/roles.ts` (explicit allow lists, no `*`, no deletes) | `test/policies/roles.live.test.ts` |
| §4, ENC-02 signed content protected from silent edits (incl. biller, AI, integration, project admins, policy-less identities) | `src/policies/lock.ts` write constraints **plus** the fork's server guard `packages/server/src/practiceai/` (enabled per project by `Project.systemSetting` `practiceai-signed-lock`) | `packages/server/src/practiceai/*.test.ts`, `test/policies/*.live.test.ts`, billing `tests/medplum-live` |
| AI-03 addendum separately authored/timestamped, original unchanged | lock rules on final `DocumentReference` (`appends` only) + server guard addendum rule + billing `createAddendum` | `guard.test.ts`, `lock.live.test.ts`, `adversarial.live.test.ts`, billing `tests/medplum-live` |
| All actions auditable; super admin is break-glass only | server guard: super-admin writes to signed content / `$expunge` / lock-flag changes are allowed but recorded as `AuditEvent` (`purposeOfEvent` BTG) in the practice project + a warn log line | `guard.test.ts`, `bypass.live.test.ts` |
| AI service reads permitted resources, writes only whitelisted workflow/claim objects | `ai_service` policy (Claim `draft` only, Task/Communication/DetectedIssue) | `roles.live.test.ts` |
| §12.3 FHIR tests (create/read/version history, references valid through claim versioning) | billing `tests/medplum-live/gateway.test.ts` | live run below |
| PT clinical content (SOAP Questionnaire, visit types, CPT/HCPCS and ICD-10 value sets) | `src/content` | `test/content` |
| Local dev / compose stack | `scripts/*.sh`, `docker-compose.practiceai.yml` | smoke, `test/e2e/compose.test.ts` |

## Package layout

```
packages/practiceai/
  README.md                this file
  .env.example             compose overrides (copy to .env, gitignored)
  src/policies/            role AccessPolicies + signed-content lock (details: src/policies/README.md)
  src/provisioning/        provisionPractice, MEDPLUM_PROJECTS output, OneTimeSecret
  src/content/             PT Questionnaire, CodeSystem/ValueSets
  src/cli.ts               provisioning / content CLI
  scripts/dev-up.sh        start pg + redis + server (idempotent); dev-down.sh stops them
  scripts/init-db.sh       roles, databases, extensions (mirrors upstream postgres/init_test.sql)
  scripts/smoke.ts         health + password login + client_credentials smoke test
  scripts/server-test.sh   run packages/server vitest against medplum_test
  scripts/provision-e2e.ts provision a synthetic PT practice + provider/admin logins (fixture for live tests / compose)
  scripts/billing-live-test.sh   provision + run the billing repo's live gateway suite
  scripts/compose-provision.sh   entry point of the compose provisioning job
  scripts/docker-build.sh  build the server/app tarballs the upstream Dockerfiles need, then docker compose build
  test/policies/ test/provisioning/ test/content/ test/e2e/   unit + live tests
  .run/                    PIDs, logs, dev credentials, e2e fixture (gitignored; contains secrets)
```

## Prerequisites

- Node 22.18+ (`node -v`), npm 10+
- Postgres 16 (Debian `pg_ctlcluster 16 main`) and `redis-server` on the host, **or** Docker
  (`docker compose -f docker-compose.practiceai.yml up -d`, then use `MEDPLUM_SKIP_LOCAL_SERVICES=1`)

## One-time setup

```bash
cd /home/user/medplum
npm ci                                              # ~several minutes
npx turbo run build --filter=@medplum/server...     # server + its workspace deps (core, definitions, fhir-router, ccda, ...)
```

`dev-up.sh` also runs these automatically if `node_modules` or the build outputs are missing.
Force a rebuild after changing server/core source with `MEDPLUM_BUILD=1` (dist mode), or use
`MEDPLUM_SERVER_MODE=dev` to run `packages/server/src` directly via tsx (no rebuild of the
server itself; core/definitions changes still need a build).

## Start / stop

```bash
bash packages/practiceai/scripts/dev-up.sh     # idempotent; or: npm run dev:up -w @practiceai/medplum-setup
bash packages/practiceai/scripts/dev-down.sh   # stops server (+ redis if dev-up started it)
bash packages/practiceai/scripts/dev-down.sh --all   # also stops Postgres if dev-up started it
```

What `dev-up.sh` does:

1. Starts Postgres cluster `16/main` if it is down (marker `.run/postgres.started-by-dev-up`).
2. Starts Redis on :6379 with `--requirepass medplum` if nothing answers there (`.run/redis.pid`).
3. `scripts/init-db.sh`: creates role `medplum`/`medplum` (not superuser), DBs `medplum` and
   `medplum_test` owned by it, the extensions the server needs (`btree_gin`, `btree_gist`,
   `pg_trgm`, `pgstattuple`, `unaccent`), and `medplum_test_readonly` (mirrors upstream
   `postgres/init_test.sql`).
4. Starts the server from `packages/server` with `file:medplum.config.json` on :8103 in its own
   process group (`setsid`), PID in `.run/server.pid`, log in `.run/server.log`, and waits for
   `GET /healthcheck`. First boot runs all schema migrations and seeds the DB (~1 min).

Env overrides: `MEDPLUM_SERVER_MODE=dist|dev`, `MEDPLUM_BUILD=1`, `MEDPLUM_CONFIG=...`,
`MEDPLUM_SKIP_LOCAL_SERVICES=1`, `MEDPLUM_HEALTH_TIMEOUT=<sec>`, `REDIS_PORT`, `REDIS_PASSWORD`.

`dev-down.sh` only kills PIDs from `.run/` (never by pattern). `.run/` is gitignored.

## Dev credentials (local only, synthetic data only)

| What | Value |
| --- | --- |
| Base URL | `http://localhost:8103/` (FHIR: `http://localhost:8103/fhir/R4/`) |
| Seeded super admin | `admin@example.com` / `medplum_admin` (from `packages/server/src/seed.ts`) |
| Postgres | `localhost:5432`, user `medplum` / `medplum`, db `medplum` (dev), `medplum_test` (tests) |
| Redis | `localhost:6379`, password `medplum` (tests use logical DB 7) |
| Dev client (client_credentials) | created by the smoke script, saved to `.run/dev-client.json` |
| E2E practice (integration client, provider + practice admin logins) | `scripts/provision-e2e.ts`, saved to `.run/e2e-practice.json` (0600) |

## Smoke test

```bash
npx tsx packages/practiceai/scripts/smoke.ts
```

Checks `/healthcheck`, logs in as the super admin via the PKCE password flow
(`POST /auth/login` then `POST /oauth2/token`), creates+reads a synthetic Patient, ensures a
`ClientApplication` ("PracticeAI Dev Smoke Client") in the Super Admin project via
`POST /admin/projects/:id/client`, and creates another Patient with a client_credentials token.

Raw curl equivalent for client credentials:

```bash
CID=$(node -p 'require("./packages/practiceai/.run/dev-client.json").clientId')
CS=$(node -p 'require("./packages/practiceai/.run/dev-client.json").clientSecret')
TOKEN=$(curl -s -X POST http://localhost:8103/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=client_credentials&client_id=$CID&client_secret=$CS" | node -p 'JSON.parse(require("fs").readFileSync(0)).access_token')
curl -s -X POST http://localhost:8103/fhir/R4/Patient -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/fhir+json' \
  -d '{"resourceType":"Patient","name":[{"given":["Synthetic"],"family":"Curl"}]}'
```

Note: the super admin and smoke client live in the Super Admin project and are for operations and
provisioning only. Practice traffic uses a per-practice project (plan §6.1): see
[Practice provisioning](#practice-provisioning-plan-61-one-medplum-project-per-practice).

## Server tests (packages/server vitest)

The server tests use `loadTestConfig()` (`packages/server/src/config/loader.ts`): database
`medplum_test`, `runMigrations: false`, Redis logical DB 7. They do not touch the dev DB, so the
running dev server can stay up. Because migrations are off, the test DB must be migrated and
seeded once with `npm run test:seed` (`src/seed.test.ts`, ~90 s); `vite.config.ts` has a
`globalSetup` that creates a shared super admin test project on every run.

```bash
# wrapper: ensures pg/redis/test DB, runs test:seed if the test DB is empty, then vitest
bash packages/practiceai/scripts/server-test.sh src/fhir/accesspolicy.test.ts -t "Access policy restricting read"
bash packages/practiceai/scripts/server-test.sh --reseed src/fhir/accesspolicy.test.ts

# or manually
cd packages/server
NODE_OPTIONS=--max-old-space-size=8192 npm run test:seed      # once per fresh medplum_test DB
npx vitest run src/fhir/accesspolicy.test.ts -t "Access policy restricting read"
```

Verified: `src/fhir/accesspolicy.test.ts` passes (70 passed, 4 skipped; single-test filter ~25 s).

Server guard tests (fork-local, `packages/server/src/practiceai/`):

```bash
bash packages/practiceai/scripts/server-test.sh src/practiceai/             # guard + predicate/parity tests
bash packages/practiceai/scripts/server-test.sh src/fhir/accesspolicy.test.ts src/fhir/repo.test.ts \
  src/fhir/operations/expunge.test.ts src/fhir/operations/botinit.test.ts src/fhir/operations/binary-presigned-url.test.ts \
  src/fhir/binary.test.ts src/storage/ src/admin/ src/fhir/batch.test.ts   # touched upstream areas
```

Do not run two `server-test.sh` invocations at the same time: they share `medplum_test` and Redis DB 7, and
the second run's global setup breaks the first (`getSuperAdminTestProject` "Not found").

Last results (2026-09-29, after the Binary / logical-reference fixes): `src/practiceai/` 118 passed (2 files);
touched upstream areas 439 passed, 4 skipped (14 files). Earlier full sweep (before those fixes): `src/fhir src/admin src/auth src/scim src/oauth src/bots src/workers` 185 files: every file passes
when run alone except `src/fhir/operations/dbinvalidindexes.test.ts`, which needs a Postgres superuser
(`UPDATE pg_index`: permission denied for the non-superuser `medplum` role; unrelated to the patch).

## Package tests

```bash
cd /home/user/medplum
npm run typecheck -w @practiceai/medplum-setup                   # src + scripts
npx tsc --noEmit -p packages/practiceai/test/policies/tsconfig.json
npx tsc --noEmit -p packages/practiceai/test/e2e/tsconfig.json
npm test -w @practiceai/medplum-setup                            # offline: unit tests; *.live.test.ts skip

cd packages/practiceai
MEDPLUM_BASE_URL=http://localhost:8103/ npx vitest run            # everything, including live suites
MEDPLUM_BASE_URL=http://localhost:8103 npx vitest run --config test/policies/vitest.live.config.ts   # policies only
MEDPLUM_BASE_URL=http://localhost:8103/ npx vitest run test/e2e   # e2e fixture + compose checks
```

Live suites need a super admin client: `MEDPLUM_ADMIN_CLIENT_ID`/`MEDPLUM_ADMIN_CLIENT_SECRET`, or
`.run/dev-client.json` written by `scripts/smoke.ts`. Each run provisions new synthetic projects
in the dev database (left in place for inspection).

Last results on the patched dev server (2026-09-29, server guard incl. Binary / logical-reference fixes, freshly
rebuilt with `MEDPLUM_BUILD=1`): offline `npm test` 59 passed / 76 skipped; with `MEDPLUM_BASE_URL` 135 passed
(14 files); policies live config 56 passed (5 files).

## Practice provisioning (plan §6.1: one Medplum project per practice)

Code: `src/provisioning/` (`provisionPractice`), CLI: `src/cli.ts`. It runs as a **super admin**
(a ClientApplication in the Medplum Super Admin project) and converges one practice to this state:

| Resource | Idempotency key (looked up before any write) | Notes |
| --- | --- | --- |
| `Project` | `identifier` = `https://practiceai.example/fhir/sid/organization-id` \| billing org UUID | `strictMode: true`, `features` ⊇ `transaction-bundles`, `systemSetting` ⊇ `practiceai-signed-lock = true` (turns on the server guard; drift is repaired, other settings kept). Renaming the practice updates `name`. |
| `Organization` (practice) | same identifier, inside the project | Adds the group NPI (`http://hl7.org/fhir/sid/us-npi`) when given, plus NUCC taxonomy. |
| `AccessPolicy` x7 | `name:exact` inside the project | From `src/policies` (`buildPracticePolicies`): provider, front_office, biller, rcm_supervisor, practice_admin, ai_service, integration. Drift is overwritten. |
| `ClientApplication` "PracticeAI Billing Integration" | `name:exact` inside the project | Membership bound to the **integration** policy. This is the billing app's `MEDPLUM_PROJECTS` client. |
| `ClientApplication` "PracticeAI AI Service" | `name:exact` inside the project | Membership bound to the **ai_service** policy. Its secret is never output (issue/rotate it in the Medplum admin UI when the AI worker gets its own identity). |
| `Practitioner` per provider | `identifier` = NPI (check digit validated) | Name/active converge; other fields edited later are kept. |
| `Practitioner` for the practice admin | `identifier` = `.../sid/provisioned-user` \| `practice-admin:<email>` | |
| `ProjectMembership` (admin, providers with e-mail) | project + profile | Created with `POST /admin/projects/:id/invite` (project-scoped user, no e-mail sent by default). Always `admin: false`: Medplum project admins bypass AccessPolicies (see `src/policies/roles.ts`). |
| PT content | `url` + `version` inside the project | Conditional create (`If-None-Exist: url=..&version=..&_project=..`). Never updated in place; bump the version to publish a change. |

Every write sets `meta.project` to the practice project, so nothing lands in the Super Admin project.
Re-running with the same input writes nothing and returns the same ids (verified live). Ambiguous
state (two resources matching one key) stops the run with an error instead of guessing.

**Secrets.** The integration client secret is returned **once**, when the client is created (or
rotated with `--rotate-secret`, which keeps the previous secret valid as `retiringSecret` until the
next rotation). It is wrapped in `OneTimeSecret`, which prints `[redacted one-time secret]` in
`JSON.stringify`, `console.log`/`util.inspect` and string conversion; call `.reveal()` exactly where
it is needed. Progress actions never contain secrets. On re-runs `clientSecret` in the output is the
placeholder `<unchanged: ...>`, which fails login instead of silently working;
`mergeMedplumProjects()` keeps the previously stored secret when merging into an existing value.

**Output** (`toMedplumProjects(result, { revealSecret })`) is exactly the billing app's
`MEDPLUM_PROJECTS` shape (`/home/user/billing/src/lib/server/config.ts` `medplumProjectsSchema`,
`src/lib/fhir/medplum-gateway.ts` `MedplumProjectConfig`):

```json
{ "<billing organization UUID>": { "projectId": "…", "clientId": "…", "clientSecret": "…", "baseUrl": "http://localhost:8103/" } }
```

After provisioning, the billing side also sets `organizations.medplum_project_id` and links each
provider membership to the `Practitioner/<id>` printed in `result.providers` (billing runbook
`docs/runbooks/medplum-setup.md` §1).

### CLI

```bash
cd /home/user/medplum
export MEDPLUM_BASE_URL=http://localhost:8103/
export MEDPLUM_ADMIN_CLIENT_ID=$(node -p 'require("./packages/practiceai/.run/dev-client.json").clientId')       # dev: smoke client (Super Admin project)
export MEDPLUM_ADMIN_CLIENT_SECRET=$(node -p 'require("./packages/practiceai/.run/dev-client.json").clientSecret')

npx tsx packages/practiceai/src/cli.ts provision \
  --name "Synthetic PT Clinic" --org 3b0f6f0e-8a57-4a39-9a55-2f2d8d5d0c11 \
  --admin-email admin@synthetic-pt.example \
  --provider 'npi=1234567893,first=Pat,last=Synthetic,email=pat@synthetic-pt.example,suffix=DPT' \
  --dry-run            # read-only: prints would-create / would-update, writes nothing

# options: --providers-file <json array of {npi,firstName,lastName,email?,suffix?,taxonomy?}>
#          --group-npi <npi> --admin-first/--admin-last --rotate-secret --send-invites
#          --user-scope project|server (default project) --no-content
npx tsx packages/practiceai/src/cli.ts content    # print the PT content as a FHIR Bundle
```

Progress goes to stderr; stdout is one JSON document `{ result, MEDPLUM_PROJECTS[, warning] }`.
`MEDPLUM_PROJECTS.<org>.clientSecret` is the real secret only on the run that issued it, with a
warning on stderr and in `warning`. Put it straight into the secret store (e.g. Vercel env); do
not paste it into tickets or commit it. `MEDPLUM_GATEWAY_BASE_URL` overrides the `baseUrl` written
into the entry (e.g. the public URL when provisioning over an internal address).

### Deprovisioning / suspension (not implemented; out of scope)

Documented procedure until it is automated (keep clinical history: never `$expunge` a practice):

1. **Suspend**: remove the org from the billing app's `MEDPLUM_PROJECTS` (the gateway then denies
   all clinical access), set both ClientApplications to `status: 'off'` (or rotate their secrets
   without distributing them), and set every practice ProjectMembership `active: false`.
2. **Offboard**: run a project `$export` (billing runbook `backup-restore.md` §3) and hand it over
   per the contract; keep the project read-only for the retention period.
3. **Delete** only after the retention period, as a separate reviewed super-admin operation.

## PT clinical content

Code: `src/content/`. Loaded into every practice project by provisioning, matching the billing
app's PT note model (`/home/user/billing/src/lib/fhir/pt-note.ts`, `pt-cpt.ts`, `constants.ts`:
same platform base URL, extension URLs, identifier systems and CPT/HCPCS codes; unit tests compare
against the billing sources when that repo is present):

| Resource | Canonical (`|version`) |
| --- | --- |
| Questionnaire "PT daily note / evaluation (SOAP)" | `https://practiceai.example/fhir/Questionnaire/pt-soap-note|1` (the value billing writes to `QuestionnaireResponse.questionnaire`) |
| CodeSystem PT visit type (`eval`, `re-eval`, `daily`) | `https://practiceai.example/fhir/CodeSystem/pt-visit-type|1` |
| ValueSet PT visit types | `https://practiceai.example/fhir/ValueSet/pt-visit-type|1` |
| ValueSet PT procedure codes (26 CPT + HCPCS G0283) | `https://practiceai.example/fhir/ValueSet/pt-procedure-codes|1` |
| ValueSet PT-common ICD-10-CM (30 codes, starter list) | `https://practiceai.example/fhir/ValueSet/pt-common-icd10|1` |

The Questionnaire keeps the four SOAP sections as top-level `text` items `subjective`,
`objective`, `assessment`, `plan` (exactly what the billing app writes). Visit type, date/time,
POS, visit number, total minutes, referring NPI, coverage, diagnoses (ICD-10), interventions
(CPT/HCPCS, minutes, units, modifiers, diagnosis pointers), plan of care (reference +
certification period) and prior authorization (number, dates, visits) are also items, each with a
`definition` naming the Encounter/Condition/Procedure element or platform extension where the
billing app stores the value. None of those is `required`, so the billing app's SOAP-only response
is complete.

### Terminology licensing

- **CPT** is copyrighted by the American Medical Association. This package lists CPT **code
  values only**, with short **platform-authored** labels (e.g. "Therapeutic exercise, each 15
  min"); no AMA descriptors are reproduced, and no CodeSystem is defined for CPT (the ValueSet only
  references `http://www.ama-assn.org/go/cpt`). Showing official CPT descriptors to users requires
  an AMA distribution license; production deployments must confirm licensing before adding them.
- **HCPCS Level II** (G0283) is published by CMS (public domain).
- **ICD-10-CM** is published by CDC/NCHS (public domain).
- Modifier labels (GP, KX, CQ, 59, XU) are platform-authored short labels.

## Provisioning / content tests

```bash
cd packages/practiceai
npx vitest run test/provisioning test/content          # unit tests (in-memory admin client); live suites skip
MEDPLUM_BASE_URL=http://localhost:8103/ npx vitest run test/provisioning test/content   # + live suites
```

Live suites (`*.live.test.ts`) use `MEDPLUM_ADMIN_CLIENT_ID`/`MEDPLUM_ADMIN_CLIENT_SECRET`, or
`.run/dev-client.json` from the smoke script. Against the real server they provision two synthetic
practices (random org UUIDs per run), provision one twice (same ids, zero writes, no new secret),
and act as the billing integration client exactly like `MedplumFhirGateway`: read Patient /
Practitioner / Organization / Coverage / Encounter / Condition / Procedure / QuestionnaireResponse,
the searches the gateway uses, a `saveNote`-style transaction with `urn:uuid` references,
`If-Match` updates (stale version rejected), the sign transaction (Encounter `finished` + signature,
QR completed, final DocumentReference), 403 on editing the signed Encounter / note afterwards, an
addendum DocumentReference (`relatesTo: appends`, original unchanged), Claim and ClaimResponse
create/update/search, and project isolation in both directions (reads by id → 404, searches empty,
`meta.project` spoofing ineffective). The synthetic projects stay in the dev database.

Crash safety: `test/provisioning/crash.test.ts` (in-memory) and `crash.live.test.ts` (real server)
make the N-th write throw for every N, rerun provisioning, and require exactly the resources of a clean
run (no duplicate Project / Organization / policies / clients / memberships) followed by a no-op run.
A ClientApplication left without a membership (the server's client endpoint is not transactional) is
repaired with a fresh secret. If a run dies after the integration client was created but before its
output was stored, the one-time secret is lost: rerun with `--rotate-secret`.

## Access policies and the signed-content lock

Code: `src/policies/` (full rule tables and findings: [`src/policies/README.md`](src/policies/README.md)).
Provisioning installs 7 AccessPolicies per practice project: `provider`, `front_office`, `biller`,
`rcm_supervisor`, `practice_admin`, `ai_service` and `integration` (the billing app's client).

- **Explicit allow lists, no `'*'`.** Anything not listed is denied, including AccessPolicy,
  ClientApplication, Bot, Subscription and ProjectMembership. No role can delete clinical or financial
  resources (the app retires lines as `entered-in-error`). Binary is create/read only.
- **Biller / RCM supervisor** read the chart but cannot write any clinical type (plan §6.1 "biller
  cannot alter signed documentation"). **AI service** reads clinical/coverage data (Patient photo,
  telecom and contact hidden) and writes only `Claim` with `status = 'draft'`, Task, Communication,
  DetectedIssue (plan §4, §6.1). **Front office** has no access to Condition, Procedure,
  QuestionnaireResponse, DocumentReference or Claim. **Provider** writes only encounters where it is a
  participant and notes it authored. **Practice admin** manages the directory, no clinical edits.

**Lock semantics** (write constraints evaluated on the stored version, so they cover PUT, PATCH,
conditional update, batch/transaction entries and GraphQL):

| Type | Locked once | Matches what the billing app writes |
| --- | --- | --- |
| Encounter | `status = 'finished'`, or the `encounter-signature` extension, or the lock label | `signEncounter` |
| DocumentReference | `docStatus = 'final'` or `'amended'` (signed note and every addendum) | signed note, addenda |
| QuestionnaireResponse | `completed` / `amended` | SOAP response completed at signing |
| Composition | `final` / `amended` / has attester | (future) |
| Condition, Procedure, Observation, ClinicalImpression | only the `meta.security` label `https://practiceai.example/fhir/CodeSystem/signed-content-lock#locked` | **not stamped by the app yet (gap below)** |

Also: `subject` can never change; an Encounter cannot be *created* finished/signed; a final
DocumentReference needs `author` and `date` and may relate to another document only with `appends`
(never `replaces`/`transforms`/`signs`), so an addendum is always a new, separately authored and
timestamped resource and the original keeps exactly one version (AI-03). An addendum must be born
`final` (a `preliminary` document with `relatesTo` is refused), and a clinical child can never be
re-linked to another encounter (so a draft cannot be moved into a signed encounter).

**Adversarial review** (`test/policies/adversarial.live.test.ts`): every write path (PUT, conditional
PUT, JSON Patch, batch and transaction entries, writing `$`-operations, DELETE incl. conditional,
`_history`, GraphQL mutations, PUT-create at a chosen id, Binary overwrite) by every role identity is
refused on a signed note, and read side channels (`_revinclude`, `_has`, chaining, `$everything`,
GraphQL, `$csv`, `_history`) do not leak hidden fields. Gaps that AccessPolicies cannot close are closed
by the server guard below where possible; the rest are listed in
[`src/policies/README.md`](src/policies/README.md#known-gaps).

### Server-side signed-content guard (fork patch, `packages/server/src/practiceai/`)

AccessPolicies cannot dereference `Procedure.encounter` and are bypassed by project admins and by identities
without a policy. The fork therefore adds a small guard inside the Medplum server. It is **enabled per project**
by `Project.systemSetting` `{ name: 'practiceai-signed-lock', valueBoolean: true }` (only a super admin can
write `systemSetting`: it is a readonly field for project admins upstream and the Project resource is not
reachable for other members; `guard.test.ts` and `bypass.live.test.ts` verify this). `provisionPractice` and
`createPracticeProject` set it; a rerun of provisioning repairs a cleared flag.

In an enabled project the guard applies to **every identity except the super admin and the server's internal
system repository**: project admins, members/clients/bots **without** an AccessPolicy, every role, the
integration and AI clients. It is evaluated after the AccessPolicy checks, on the stored version, inside the
repository, so it covers PUT, PATCH, conditional create/update/delete, batch and transaction entries, GraphQL
mutations and `$`-operations that write through the repository. Refusals are HTTP 403 with
`issue[0].details.coding = { system: 'https://practiceai.example/fhir/CodeSystem/signed-lock-outcome', code }`:

| Rule | Code |
| --- | --- |
| Update / patch / delete of a **signed** resource (the `lock.ts` predicates: Encounter finished/signature/label, DocumentReference final/amended, QuestionnaireResponse completed/amended, Composition final/amended/attested, labelled Condition/Procedure/Observation/ClinicalImpression). Covers status reversal. | `signed-content-locked` |
| Update / patch / delete of **any** Condition, Procedure, Observation, ClinicalImpression, QuestionnaireResponse, DocumentReference or Composition that references a signed Encounter of the same project, **labelled or not**; moving a draft child into a signed encounter. "References" means **any element** (not only `encounter` / `context.encounter`: also `focus`, `evidence.detail`, extensions, contained resources, ...) and **both forms**: literal `Encounter/<id>` (relative, absolute, versioned) and logical references (a Reference `identifier` with `type` `Encounter` or no type), which the guard resolves by `Encounter.identifier` within the project (as last committed). The stored and the new version are both checked. | `encounter-signed` |
| **Create** of any of those types referencing a signed Encounter (same meaning), **except an addendum**: a `DocumentReference` with `docStatus = final`, `author` and `date`, literal encounter links, whose every `relatesTo` is `appends` and targets an existing signed DocumentReference of the same project that belongs to the same encounter | `encounter-signed` |
| Create / update of any of those types whose `encounter` (`context.encounter` for DocumentReference) link is **not a literal reference**: identifier-only (logical), contained (`#id`), display-only, or a non-Encounter target (`EpisodeOfCare/<id>` is allowed for DocumentReference). Conditional (`Encounter?identifier=...`) and `urn:uuid` references are rewritten to literal ones by the server before the guard runs, so they keep working. A logical reference whose identifier contains search syntax (`|`, `,`, `$`, `\`) or matches 1000+ encounters is treated as signed. | `encounter-reference-invalid` |
| Update, delete, or `$presigned-url?upload=true` of **any `Binary`** (raw PUT, FHIR PUT/PATCH, batch/transaction, GraphQL). Binaries are write-once in a locked project because attachments (the signed note's body) point at `Binary/<id>` **without a version** and resolve to the latest one; an upload URL would even overwrite the current version's bytes in storage without a new version. Creating new Binaries (e.g. an addendum's content) is unaffected. | `binary-immutable` |
| `$expunge` (single, `everything=true`, `Project/$expunge`) of anything | `expunge-forbidden` |
| ProjectMembership create/update (FHIR, `/admin/projects/:id/members/:id`, `/client`, `/bot`, `/invite`, `Bot/$init`, SCIM) without `accessPolicy`/`access` (deactivating with `active: false` is allowed), or with a policy from another project | `membership-policy-required` / `membership-policy-foreign` |
| Setting `ProjectMembership.admin = true` (invite or update) | `membership-admin-forbidden` |
| Changing `Project.setting`, `systemSetting`, `systemSecret`, `features`, `checkReferencesOnWrite`, `strictMode`, `superAdmin`, `link`, `defaultAccessPolicies`, `defaultPatientAccessPolicy` (incl. `/admin/projects/:id/settings`), or deleting the Project | `project-settings-locked` |
| Create / update / delete of `AccessPolicy` (policies are provisioned by the super admin) | `access-policy-super-admin-only` |
| Update / delete of `AuditEvent` | `audit-immutable` |

- **Encounter state is read as last committed**, on a separate connection, restricted to the same project. So
  the signing transaction itself (Encounter PUT finished + QuestionnaireResponse PUT completed + note POST, in
  any order) still works, and every later request sees the encounter as signed. A literal encounter reference
  that does not resolve in the project (another practice's id, a dangling id) is treated as "not signed" and
  gives no access to the other project; a logical reference is only resolved within the project, and a
  non-literal `encounter` link is refused outright (`encounter-reference-invalid`).
- **Super admin = break-glass.** Its writes are allowed; a write that a member would be refused for signed
  content, children of a signed encounter, `$expunge`, `AuditEvent`, a `Binary` overwrite/delete/upload URL, or a
  change of the lock flag itself is
  logged (`PRACTICEAI break-glass` warn line) and recorded as an `AuditEvent` in the practice project with
  `purposeOfEvent` `v3-ActReason#BTG`, the entity, and the reason code (saved after commit, so a rolled-back
  write leaves only the log line). Routine super-admin configuration (provisioning policies, memberships) is
  not flagged as break-glass.
- **Unflagged projects are untouched** (upstream behaviour; `guard.test.ts` "unflagged project" and the
  `bypass.live.test.ts` contrast block).
- The pure predicates are duplicated in `packages/server/src/practiceai/signed-lock.ts` (the server must not
  depend on this private package); `signed-lock.test.ts` evaluates the `lock.ts` FHIRPath predicates and
  encounter link paths on shared fixtures and asserts parity, plus the reason codes in `constants.ts`
  `SIGNED_LOCK_REASONS` against the guard's `LockReason`. **Change both together.** The guard is deliberately
  stricter than `lock.ts` in three places that have no FHIRPath equivalent (so they are server-only and not in
  the parity check): the whole-resource Encounter reference scan, logical-reference resolution, and the
  literal-link rule; plus the Binary write-once rule.

**Who bypasses the lock now (tested on this build, `test/policies/bypass.live.test.ts`):**

| Identity | Result in a practice (flagged) project |
| --- | --- |
| Super admin | Allowed (break-glass), and every write to signed content / `$expunge` / flag change is audited (`AuditEvent` BTG). Operations/provisioning only. |
| ClientApplication or membership **without** an AccessPolicy | Still full AccessPolicy access to unlocked data (legacy `*`), but refused by the guard for everything above, including overwriting the Binary behind a signed note (`binary-immutable`). The guard refuses creating such memberships unless the caller is the super admin. |
| Project admin (`membership.admin = true`), with or without a policy | Ordinary writes obey its policy (if any); the former bypasses are refused: (a) `$expunge` → `expunge-forbidden`, (b) removing its own policy → `membership-policy-required`, (c) minting a policy-less client/bot/invite → `membership-policy-required`, plus `admin: true` grants and project settings, (d) overwriting / deleting / getting an upload URL for a signed note's Binary → `binary-immutable`, (e) attaching children by identifier-only reference → `encounter-reference-invalid` / `encounter-signed`. |

**Remaining limitations of the guard (honest list; details in [`src/policies/README.md`](src/policies/README.md#known-gaps)):**

- Only the seven clinical child types are locked through their encounter. Other resources may still reference a
  signed Encounter (Claim, ChargeItem, Media, DiagnosticReport, ServiceRequest, Task, ...) by design; billing
  writes Claims after signing.
- Signed content stored **outside** a Binary of the same project (an attachment `url` to an external server, a
  `Media` or `DocumentReference` in another resource the note links to) is not protected by the Binary rule. The
  platform stores note bodies inline (`attachment.data`, locked with the note) or in a project Binary.
- Binaries are write-once for **every** member in a flagged project, not only the ones a signed note
  references (a version-less `Binary/<id>` pointer cannot be pinned, and a reverse lookup would miss other
  attachment-bearing types). Replacing a draft attachment means creating a new Binary and pointing the draft at it.
- Logical references are resolved by `Encounter.identifier` token search in the same project. A consumer that
  resolves identifiers differently (e.g. case-insensitive, across projects, or by another element) could
  link a resource the guard sees as unrelated; references in non-child resource types are not resolved at all.
- Legacy child resources that already carry a non-literal `encounter` link must be fixed to a literal link
  before they can be updated in a flagged project (`encounter-reference-invalid`).
- The signing race (a concurrent transaction committing a child while the signing transaction is in flight) is
  unchanged; see Known gaps 5.
- Resources created during the adversarial review on the dev database (identifier-linked Procedures /
  Observations / a shadow DocumentReference, a forged Binary version) were left in place for inspection; they
  are synthetic.

So **no day-to-day identity is a project admin or super admin**: `practice_admin` is a normal member
(`admin: false`), and provisioning never grants `admin: true`.

**Atomic transactions** need `Project.features` to include `transaction-bundles`; without it Medplum
runs a `transaction` Bundle with batch semantics (earlier entries commit when a later one is
rejected). Both `createPracticeProject` and `provisionPractice` set it (the latter used to omit it; a
rerun of provisioning now repairs existing projects).

**Closed (verified live):** the billing app's `signEncounter` does not stamp the lock label on the
encounter's Conditions and Procedures; the server guard now locks them anyway (`lock.live.test.ts`
"CLOSED (server guard)", `provision.live.test.ts`), and refuses new children on the signed encounter
(`adversarial.live.test.ts` "CLOSED (server guard)"). Billing patch 0001 (stamp the label) remains useful
defense in depth but is no longer required for the server to hold. The billing repo's own live suite
(`tests/medplum-live/tamper.test.ts`, owned by the billing team, not run or edited here) still asserts the old
server behaviour (new Procedure on a signed encounter → 201) and will report that as changed against this build.

## Live verification of the billing gateway (billing GAP-03)

```bash
cd /home/user/medplum
bash packages/practiceai/scripts/billing-live-test.sh           # fresh synthetic practice per run
bash packages/practiceai/scripts/billing-live-test.sh --reuse   # reuse .run/e2e-practice.json
MEDPLUM_LIVE_STRICT=1 bash packages/practiceai/scripts/billing-live-test.sh   # KNOWN-GAP test as a normal (failing) test
# env: MEDPLUM_BASE_URL (default http://localhost:8103/), BILLING_DIR (default ../billing)
```

What it does:

1. Starts the dev server if `/healthcheck` does not answer, and creates the super admin client
   (`smoke.ts`) if `.run/dev-client.json` is missing.
2. `scripts/provision-e2e.ts --fresh`: `provisionPractice()` for a new random billing organization
   UUID, with the billing seed's synthetic provider (NPI 1234567893, Pat Placeholder, PT) and a
   practice admin; sets random passwords for both through `POST /admin/super/setpassword`; writes
   `.run/e2e-practice.json` (mode 0600): `{ baseUrl, organizationId, projectId, MEDPLUM_PROJECTS,
   provider, admin }`.
3. Runs the billing repo's suite with its own config:
   `MEDPLUM_LIVE_FIXTURE=… npx vitest run --config tests/medplum-live/vitest.config.ts` (in `BILLING_DIR`).

The billing suite (`tests/medplum-live/gateway.test.ts`, `container.test.ts`) builds the **real**
`MedplumFhirGateway` from the provisioned `MEDPLUM_PROJECTS` (default client factory, client
credentials) and, for the provider, the same gateway code over the provider's own password login.
The practice admin creates the Location (the integration policy keeps the directory read-only), the
integration client registers the patient (`registerIntake`), and the provider saves and signs the
note with the same resource shapes as the in-memory seed (`syntheticDailyNote`). It checks: project
routing and wrong-project refusal; the finished encounter read back (author = the provider);
`getSignedNote().contentHashValid` after server normalization; `getBillingContext` equal to the
in-memory gateway's for the same data (ids normalized); lock behavior in the app (all identities get
`SignedContentLockedError`) **and** on the server (raw client PUT/DELETE on the signed Encounter,
note and QuestionnaireResponse → 403; the adapter maps it to `TenantAccessError`); stale `If-Match`
→ `FhirVersionConflictError`; `createAddendum` (new final DocumentReference that `appends`, original
note and Encounter history unchanged, addendum itself immutable); `upsertClaim` v1 (idempotent),
v2 (separate replacement Claim, `related.claim` → v1), v1 updated in place with `If-Match` while
every reference of v2 (prior Claim, Patient, Coverage, Encounter) still resolves and vread returns the
original; `recordClaimResponse` (linked, searchable by `request`); and `buildServices` with
`FHIR_MODE=medplum`.

`tests/medplum-live/tamper.test.ts` (adversarial review) attaches a NEW Procedure/Condition to a signed
encounter through the raw integration client and provider and checks that `getBillingContext` refuses to
bill it (expected failure until billing patch `0003-billing-context-verifies-signed-hash.diff`). **With the
server guard build, the server now refuses that write (403 `encounter-signed`)**, so this billing test and the
Condition/Procedure `it.fails` case no longer see the behaviour they were written against; the billing team
should update them (their repo is not edited from here, and the billing suite was not rerun against the guard
build).

Last run before the server guard (2026-09-29, after the adversarial review): **19 passed, 2 expected failures, 2 skipped**. The
expected failures (`it.fails`) are the Condition/Procedure lock gap (patch 0001) and the unchecked
billing context (patch 0003). The 2 skipped are the `buildServices` boot tests in `container.test.ts`:
the billing app now refuses `AUTH_MODE=demo` with `FHIR_MODE=medplum`, and Supabase auth needs Supabase
credentials (set `STORE_MODE`/`AUTH_MODE=supabase` and the `SUPABASE` variables to run them); the refusal
itself is asserted. With patches 0001+0002+0003 applied to a scratch copy of the billing repo: strict live
run **21 passed, 2 skipped**; full billing unit suite 1611 passed, 23 skipped; `tsc` clean.

## Compose stack (`docker-compose.practiceai.yml`)

Two modes in one file:

| Mode | Command | Services |
| --- | --- | --- |
| Backing services (default) | `docker compose -f docker-compose.practiceai.yml up -d` then `MEDPLUM_SKIP_LOCAL_SERVICES=1 bash packages/practiceai/scripts/dev-up.sh` | `postgres` (16, upstream `postgres/` init scripts), `redis` (7, password `medplum`) |
| Full stack (profile `stack`) | see below | + `medplum-server`, `medplum-app`, `practiceai-provision`, `billing` |

```bash
cd /home/user/medplum
cp packages/practiceai/.env.example packages/practiceai/.env        # optional; every value has a dev default
docker login dhi.io                                                 # server base images are Docker Hardened Images
bash packages/practiceai/scripts/docker-build.sh                    # tarballs + docker compose build
docker compose --env-file packages/practiceai/.env -f docker-compose.practiceai.yml --profile stack up -d
# Medplum API http://localhost:8103  Medplum app http://localhost:3000  billing http://localhost:3100
docker compose -f docker-compose.practiceai.yml --profile stack down        # add -v to drop the volumes
```

- **medplum-server** is built from this fork with the upstream `./Dockerfile`, unchanged. That
  Dockerfile has **no build args**: its inputs are `medplum-server-metadata.tar.gz` and
  `medplum-server-runtime.tar.gz` in the build context, which `scripts/docker-build.sh` produces
  exactly like upstream `scripts/build-docker-server.sh` (after `turbo run build --filter=@medplum/server...`).
  Base images `dhi.io/node:24.18(-dev)` need `docker login dhi.io`. Runtime config comes from
  `MEDPLUM_*` env vars (`command: ['env']`). First boot migrates and seeds the dev super admin.
- **medplum-app** uses upstream `packages/app/Dockerfile` (no build args) with
  `packages/app/medplum-app.tar.gz`, built with `__MEDPLUM_BASE_URL__`-style placeholders that its
  `docker-entrypoint.sh` replaces from the container env (`MEDPLUM_BASE_URL`, `MEDPLUM_CLIENT_ID`,
  `GOOGLE_CLIENT_ID`, `RECAPTCHA_SITE_KEY`, `MEDPLUM_REGISTER_ENABLED`, `MEDPLUM_AWS_TEXTRACT_ENABLED`).
- **practiceai-provision** (one-shot, inline Dockerfile from `scripts/` + `src/`) runs
  `scripts/compose-provision.sh`: waits for health, creates the super admin client, provisions the
  synthetic practice for `PRACTICEAI_ORG_ID` (default the billing app's demo org
  `d0000000-0000-4000-8000-00000000d001`), and writes `MEDPLUM_PROJECTS='{…}'` to
  `/shared/medplum-projects.env` (named volume, mode 0600). Idempotent: state lives in the
  `practiceai-run` volume, so a restart keeps the project and the secret.
- **billing** is built from `${BILLING_DIR:-../billing}` (inline Dockerfile: `npm ci`, `next build`,
  `next start -p 3100`), starts after the provisioning job succeeded, sources
  `/shared/medplum-projects.env` (read-only mount) and runs with `FHIR_MODE=medplum`,
  `MEDPLUM_BASE_URL=http://medplum-server:8103/`, mock clearinghouse, mock AI, `APP_ENV=development`
  (synthetic only). **Auth:** billing now refuses demo auth with `FHIR_MODE=medplum`, so the service
  defaults to `STORE_MODE`/`AUTH_MODE=supabase` and reads `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` from the host environment; without a
  (synthetic) Supabase project it refuses to start. `SEED_DEMO=false`: the in-app demo seed creates Practitioner
  and Location resources, which the integration policy keeps read-only (verified live by billing
  `tests/medplum-live/container.test.ts`), so the demo practice is not seeded in this mode yet. Billing
  patch `docs/medplum/patches/0002-seed-reuses-provisioned-directory.diff` makes the seed reuse the
  provisioned Practitioner (NPI) and the Location that `provision-e2e.ts` creates as the practice admin;
  with it applied, set `SEED_DEMO: 'true'` (verified live against the dev server).

No secret is committed: the compose file carries only the upstream dev defaults (Postgres/Redis
`medplum`, seeded `admin@example.com` / `medplum_admin`); overrides go in the gitignored
`packages/practiceai/.env`; the integration client secret is generated at runtime.

**Validation:** `docker compose -f docker-compose.practiceai.yml config --quiet` and the same with
`--profile stack` (and with `--env-file packages/practiceai/.env.example`) pass; `test/e2e/compose.test.ts`
checks the resolved model. `scripts/docker-build.sh --no-docker` ran successfully (server metadata
323K, server runtime 14M, app 2.0M tarballs; the app bundle carries the `__MEDPLUM_BASE_URL__`
placeholders). The Docker daemon is not available in the environment where this was written, so the
images were **not built or started** there; the provisioning job's script was run
directly against the dev server (`MEDPLUM_BASE_URL=http://localhost:8103/ PRACTICEAI_SHARED_DIR=<dir>
bash packages/practiceai/scripts/compose-provision.sh`, twice, second run reused the secret) and the
billing container's config path (`buildServices` with that `MEDPLUM_PROJECTS`) is covered by the
billing live suite.

## Fork maintenance

Files that belong to PracticeAI (never in upstream):

- `packages/practiceai/**` (this package; `.run/` and `.env` are gitignored)
- `docker-compose.practiceai.yml`
- `packages/server/src/practiceai/**` (server guard: `guard.ts`, `signed-lock.ts`, `guard.test.ts`, `signed-lock.test.ts`)

Upstream files modified:

- `package-lock.json`: exactly two added entries for the new workspace (`node_modules/@practiceai/medplum-setup`
  link and `packages/practiceai`, 21 lines). The lockfile was restored after `npm install` (the local npm 10
  had dropped unrelated `libc` fields) and only those entries re-added.
- 14 added lines in 6 server files, each a single import or a single `await practiceAi...()` call ending in a
  `// PRACTICEAI:` comment (find them with `git grep -n 'PRACTICEAI:' packages/server/src`), no upstream line
  changed or removed:

  | File | Line (after patch) | Hook |
  | --- | --- | --- |
  | `packages/server/src/fhir/repo.ts` | 74 | import |
  | `packages/server/src/fhir/repo.ts` | 1082 | `practiceAiGuardWrite(this, existing, result)` in `updateResourceImpl`, after `isResourceWriteable` |
  | `packages/server/src/fhir/repo.ts` | 1376 | `practiceAiGuardDelete(this, resource)` in `deleteResource`, after the DELETE permission check |
  | `packages/server/src/fhir/repo.ts` | 1544 | `practiceAiGuardExpunge(this, resourceType, ids)` in `expungeResources` |
  | `packages/server/src/fhir/operations/expunge.ts` | 19, 42 | import; `practiceAiGuardExpunge` before the async Project/everything job (403 instead of 202) |
  | `packages/server/src/admin/client.ts` | 11, 43 | import; `practiceAiGuardNewMembership` in `createClient` (membership is written with the system repo) |
  | `packages/server/src/fhir/operations/botinit.ts` | 20, 97 | import; `practiceAiGuardNewMembership` at the start of `createBot` (`/admin/projects/:id/bot`, `Bot/$init`) |
  | `packages/server/src/admin/invite.ts` | 42, 454 | import; `practiceAiGuardNewMembership` in `upsertProjectMembership` after defaults (invite, SCIM) |
  | `packages/server/src/fhir/operations/binary-presigned-url.ts` | 7, 38 | import; `practiceAiGuardBinaryUpload(repo, resource, params.upload)` after the upstream UPDATE check (an upload URL overwrites the Binary's current bytes directly in storage, bypassing the repository) |

The upstream Dockerfiles, compose files and app are used as is (the server image is built from this fork, so it
contains the guard).

Merging upstream:

```bash
git remote add upstream https://github.com/medplum/medplum.git   # once
git fetch upstream
git merge upstream/main             # or rebase; conflicts only in package-lock.json or next to a PRACTICEAI: hook line
git grep -n 'PRACTICEAI:' packages/server/src   # expect the 14 hook lines listed above; re-add any a merge dropped
# on a package-lock.json conflict: take upstream's file, then re-add our workspace entries with the
# npm major upstream uses (npm 10 strips unrelated "libc" fields; revert anything but our 2 entries)
git checkout --theirs package-lock.json && npm install --package-lock-only
git diff package-lock.json          # expect only the @practiceai/medplum-setup entries (plus upstream's own changes)
npm ci && npx turbo run build --filter=@medplum/server...
bash packages/practiceai/scripts/dev-up.sh
npx tsx packages/practiceai/scripts/smoke.ts
(cd packages/practiceai && MEDPLUM_BASE_URL=http://localhost:8103/ npx vitest run)   # policies, provisioning, content, e2e
bash packages/practiceai/scripts/billing-live-test.sh                                 # billing gateway against the new build
```

After every upstream upgrade re-run the server guard tests (`server-test.sh src/practiceai/`) and the live
policy suites: they pin behavior this platform relies on (AccessPolicy write constraints on `%before`,
transaction atomicity with `transaction-bundles`, the guard closing the admin bypasses listed above, and
`systemSetting` staying super-admin only). If upstream adds a new write path that does not go through
`Repository.updateResourceImpl` / `deleteResource` / `expungeResources`, or a new route that writes a
ProjectMembership with the system repository, it needs a hook too. `package.json` dependency versions of this package follow the
repo's (`@medplum/core` 5.1.42 etc.); bump them with the upstream version.

Lint: the repo's ESLint config requires the Orangebot SPDX header (`header/header`). PracticeAI
files intentionally do not carry Orangebot's copyright line; add the platform's own header once the
licensing/branding decision is made. The server guard files carry `SPDX-License-Identifier: Apache-2.0` and an
`eslint-disable header/header` comment so `eslint` passes in `packages/server`.
