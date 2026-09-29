# PracticeAI access policies and the signed-encounter lock

This folder holds the AccessPolicy builders for each practice project (plan §6.1) and the server-side lock on signed encounters (plan §4, ENC-02, AI-03). The live tests in `test/policies/` check every rule below against the real server.

```bash
# offline unit tests (part of `npm test -w @practiceai/medplum-setup`; live suites are skipped)
npm test -w @practiceai/medplum-setup
# live tests against a running server (see scripts/dev-up.sh)
cd packages/practiceai && MEDPLUM_BASE_URL=http://localhost:8103 npx vitest run --config test/policies/vitest.live.config.ts
# typecheck including tests
npx tsc --noEmit -p packages/practiceai/test/policies/tsconfig.json
```

Each live run creates new synthetic projects named `practiceai-test-{a,b}-<run>` in the dev database.

## API

- `buildRolePolicy(role, { projectId, practiceLabel? })` builds the AccessPolicy for one role. `buildPracticePolicies(opts)` builds all of them.
- `upsertPracticePolicies(superAdminClient, opts)` creates or updates the policies in a practice project. It is idempotent and matches on name.
- `createPracticeProject(superAdminClient, name)` creates a project with `features: ['transaction-bundles']`. This feature is required: see finding 5.
- `inviteRoleUser(...)` creates a human user with a Practitioner profile. It always sets `admin: false`. `createRoleClient(...)` creates a ClientApplication bound to a policy, for `ai_service` and the billing integration.
- `lockedEntry`, `LOCK_PREDICATES`, `buildSignLockEntries`, `withLockLabel` are the lock building blocks.

## Roles

| Role | Reads | Writes (create/update; **no role has delete on clinical or financial types**) |
| --- | --- | --- |
| provider | chart, demographics, coverage, directory, claims (read only) | Encounter where `participant=%profile`; Condition, Procedure, Observation, ClinicalImpression; QuestionnaireResponse where `author=%profile`; DocumentReference and Composition where `author=%profile` (notes and addenda); CarePlan and similar; Task, Communication; Binary (create only) |
| front_office | Encounter visit list (`diagnosis`, `reasonCode`, `reasonReference` and `extension` hidden); directory | Patient, RelatedPerson, Coverage (beneficiary cannot change), Appointment, Schedule, Slot, CoverageEligibilityRequest, Task, Communication, Binary (create). **No access** to Condition, Procedure, QuestionnaireResponse, DocumentReference or Claim |
| biller | all clinical (read only), demographics | Coverage (beneficiary cannot change), Claim, ClaimResponse, ExplanationOfBenefit, Account, ChargeItem, Invoice, Payment*, CoverageEligibility*, Task, Communication |
| rcm_supervisor | same as biller, plus AuditEvent | same as biller, plus DetectedIssue (disposition of AI findings) |
| practice_admin | chart (read only), financial (read only), AuditEvent, AccessPolicy (read only), ClientApplication with `secret` hidden | Practitioner, PractitionerRole, Organization, Location, HealthcareService, scheduling, Task. **No clinical edits.** Not a Medplum project admin (see below) |
| ai_service | clinical note types, Patient (`photo`, `telecom` and `contact` hidden), Coverage, directory, ClaimResponse | **only** Claim with `status = 'draft'` (it can never submit one or edit a non-draft claim), Task, Communication, DetectedIssue |
| integration (billing app) | the app's `SUPPORTED_RESOURCE_TYPES` plus workflow types | Patient, RelatedPerson, Organization, Coverage, all clinical note types (with the lock), financial types, workflow types, Binary (create). Practitioner and Location are read only |

No policy uses `'*'`. Anything not listed is denied, including AccessPolicy, ClientApplication, Bot, Subscription and ProjectMembership. Binary is create/read only, so a Binary referenced by a signed document can never be overwritten.

## Signed-encounter lock

Every writable entry for `Encounter, Condition, Procedure, Observation, ClinicalImpression, QuestionnaireResponse, DocumentReference, Composition` carries these write constraints (`lock.ts`):

1. **The stored version must not be locked**: `%before.exists().not() or %before.where(<locked>).exists().not()`. This blocks PUT, PATCH, status reverts, removing the signature, removing the label, and conditional updates. It also covers batch and transaction entries and GraphQL mutations, because they all go through `Repository.updateResourceImpl`. The "locked" test differs by type:

   | Type | Locked when | Matches what the app writes |
   | --- | --- | --- |
   | Encounter | `status = 'finished'`, or the signature extension (`https://practiceai.example/fhir/StructureDefinition/encounter-signature`), or the lock label | `signEncounter` PUT |
   | DocumentReference | `docStatus = 'final'`, or the lock label | signed note and addenda |
   | QuestionnaireResponse | `completed` or `amended`, or the lock label | the SOAP response is completed during signing |
   | Composition | `final` or `amended`, or has an attester, or the lock label | (future) |
   | Condition, Procedure, Observation, ClinicalImpression | only the lock label: `meta.security` `https://practiceai.example/fhir/CodeSystem/signed-content-lock#locked` (the **server guard** also locks them, labelled or not, when their encounter is signed: finding 1) | label: billing patch 0001; guard: always |

2. `subject` cannot change, so a record cannot be moved to another patient.
3. An Encounter cannot be *created* finished or signed. It can only reach that state by the transition from an existing draft.
4. A DocumentReference with docStatus final needs `author` and `date`, and `relatesTo` may only use `appends`. `replaces`, `transforms` and `signs` are rejected, so no new document can supersede signed content.
5. An addendum (any DocumentReference with `relatesTo`) must be written `docStatus = final`, so it is locked from its first version; `docStatus = amended` also counts as signed. Without this a `preliminary` document that `appends` the note would be listed by the app as an addendum while staying editable.
6. Once written, a clinical child (Condition, Procedure, Observation, ClinicalImpression, QuestionnaireResponse, Composition: `encounter`; DocumentReference: `context.encounter`) cannot be re-linked to another encounter, and the link cannot be added or removed. This stops a draft Procedure being moved into an already signed encounter.
7. **Delete**: writeConstraint is not evaluated on DELETE, but DELETE is its own AccessPolicy interaction, and no PracticeAI policy grants it on clinical or financial types. The billing app never deletes; it retires draft lines as entered-in-error.

The live tests confirm every role, including the provider and the integration client, gets 403 on PUT, PATCH, status revert and DELETE of a signed Encounter, the note, the QuestionnaireResponse, and labelled Conditions and Procedures. Addenda are created as new final DocumentReferences. The original keeps exactly one version, and its vread output is identical to the signed content. A transaction that touches signed content is rolled back as a whole.

## Server-side guard (fork patch)

The rules above are AccessPolicy write constraints. The fork adds a server-side guard
(`packages/server/src/practiceai/guard.ts`, enabled by `Project.systemSetting` `practiceai-signed-lock = true`,
which `createPracticeProject` and provisioning set) that enforces the same lock for **every identity except the
super admin**, independent of AccessPolicies, and resolves `encounter` / `context.encounter` server-side. Rules
and reason codes: package README, "Server-side signed-content guard". Its pure predicates
(`packages/server/src/practiceai/signed-lock.ts`) mirror `LOCK_PREDICATES` / `ENCOUNTER_LINK_PATH` in `lock.ts`;
`signed-lock.test.ts` asserts parity on shared fixtures, so **change both together**.

## Who bypasses the lock (tested on this build, `bypass.live.test.ts`)

| Identity | AccessPolicy alone | With the server guard (practice projects) |
| --- | --- | --- |
| Super admin (seeded admin, no policy) | Bypasses: can revert and delete signed content. | Still allowed (break-glass), but each such write, `$expunge` and lock-flag change is recorded as an `AuditEvent` (purposeOfEvent BTG) in the practice project. Operations only. |
| ClientApplication or membership **without** an AccessPolicy | Bypasses (legacy `'*'`, no constraints). | Refused (`signed-content-locked`, `encounter-signed`, `access-policy-super-admin-only`); only the super admin can create such a membership. |
| ClientApplication **with** a policy (billing integration, AI) | Bound by the policy. | Bound by the policy and the guard. |
| Project admin (`membership.admin = true`) with a restrictive policy | Ordinary writes obey the policy, but (a) `$expunge` destroys a signed note and its history, (b) it can remove `accessPolicy` from its own membership, (c) `POST /admin/projects/:id/client` mints an unrestricted client. | (a) `expunge-forbidden`, (b) `membership-policy-required`, (c) `membership-policy-required`; also no `admin: true` grants, no foreign policies, no `Project.setting` / `checkReferencesOnWrite` changes. `systemSetting` / `features` stay readonly (upstream). |

Consequences:

- **No day-to-day identity may be a Medplum project admin or super admin.** `practice_admin` is a normal member (`admin: false`). User management for a practice goes through the platform's provisioning flow: the billing app's platform-admin screens, which call `inviteRoleUser` or `createRoleClient` using an operations identity that is kept out of practice traffic.
- Project admins cannot change `Project.features` or `Project.systemSetting` (upstream readonly fields); in a practice project the guard also refuses `Project.setting` and `checkReferencesOnWrite` changes.

## Findings and gaps

1. **Condition and Procedure of an app-signed encounter (CLOSED by the server guard).** AccessPolicy criteria and FHIRPath cannot dereference `Procedure.encounter`, so policies alone lock Conditions and Procedures only when the signing transaction stamps the lock label (`buildSignLockEntries`; the billing app's `signEncounter` does not add them yet, billing patch 0001). The server guard resolves the encounter and locks every child of a signed encounter whether labelled or not (`lock.live.test.ts` "CLOSED (server guard)").
2. **Project admins and policy-less identities bypass AccessPolicies (CLOSED by the server guard for the lock; see the table above).** The super admin remains a break-glass identity, audited.
3. **Addendum authorship for the integration client.** The server makes sure an addendum is a new, final, authored and dated DocumentReference that `appends`. For the integration client it cannot check that the named author approved it. The app records `addendum-approved-by`.
4. **Human providers who use Medplum directly** must set `Procedure.performer`, `QuestionnaireResponse.author` and `DocumentReference.author` to themselves. Condition has no "own" criteria.
5. **Atomic transactions need `Project.features` to include `transaction-bundles`.** Without it, Medplum processes `transaction` bundles with batch semantics: entries before a rejected entry still commit. This was seen on the live server. `signEncounter` and note autosave depend on atomicity. `createPracticeProject` sets the feature. Existing projects need a super admin to add it.

## Adversarial review (`adversarial.live.test.ts`, `test/provisioning/crash*.test.ts`)

Every write path was tried against a signed note, by every role identity (provider, second provider, front office, biller, RCM supervisor, practice admin, AI service client, integration client). All are refused and the signed resources keep their exact version:

| Path | Result |
| --- | --- |
| PUT, conditional PUT (`Encounter?_id=`), JSON Patch (status incl. `test`+`replace`, remove signature extension, remove/replace `meta`, note content, QR status) | 403 |
| batch entry / transaction PATCH entry | 403 (batch entry status `403`, transaction rolled back) |
| `$refresh-reference-display` (patches through the repository) | 403 |
| `$set-accounts`, `$expunge` (project admin only) | 403 |
| DELETE, conditional DELETE | 403 |
| `PUT` / `DELETE` on `_history/<vid>` | no such route (404) |
| GraphQL `EncounterUpdate` / `EncounterDelete` / `DocumentReferenceUpdate` | GraphQL error `Forbidden`, no data |
| PUT to a new client-chosen id, conditional PUT-create of a finished Encounter | refused (404 / 403) |
| Binary: raw PUT, FHIR PUT, PATCH, DELETE | 403, content unchanged |
| create AccessPolicy / ClientApplication / Bot / Subscription / ProjectMembership / Project, `POST /admin/projects/:id/client` | 403 |

Read side channels checked: front office gets 403 for `_revinclude=Condition`, `_has:Condition`, chained `diagnosis:Condition.code`; `$everything`, `_history`, vread, `_elements`, GraphQL and `$csv` do not reveal hidden Encounter fields; AI service never receives Patient `telecom`/`photo` through `_include`, `$everything`, GraphQL, vread, `$csv`; practice admin never receives a ClientApplication `secret` through read, search, `_history`, `_elements` or GraphQL.

### Known gaps

Each has a live test asserting today's behavior.

1. **New children on a signed encounter (CLOSED by the server guard).** `adversarial.live.test.ts` "CLOSED (server guard)" now asserts 403 `encounter-signed` for new Procedure / Condition / completed QuestionnaireResponse / competing final progress note (REST and transaction), and that a real addendum is still accepted. Historical description (before the guard): the provider and the integration client could *create* a new Procedure, Condition, completed QuestionnaireResponse or final progress note whose encounter reference points at a finished encounter (HTTP 201). A write constraint only sees the written resource and cannot dereference `Procedure.encounter`. What is created is itself locked from birth when final, and the signed content hash no longer verifies, but billing's `getBillingContext` bills whatever `encounter=` returns without re-checking the hash. Billing patch `docs/medplum/patches/0003-billing-context-verifies-signed-hash.diff` makes it refuse (`SignedContentIntegrityError`); live test `tests/medplum-live/tamper.test.ts`. The option implemented is close to (b) but in-process: the guard hooks the repository write path. Options considered: (a) a reference-aware write constraint, e.g. a `%resolve()` / `%encounter` variable resolved by `Repository.isResourceWriteable` through the caller's repo, so a policy can say `%after.encounter.resolve().where(status = 'finished').exists().not()`; or (b) a pre-commit Bot (`preCommitSubscriptionsEnabled` in server config + project setting) that rejects Condition/Procedure/Observation/QuestionnaireResponse/DocumentReference writes pointing at a signed Encounter.
2. **`Project/$init` is open to every authenticated identity** (upstream `projectInitHandler` has no super admin check). The AI service and integration ClientApplications can create empty projects; a project-scoped user can create a project for a new server-scoped User by e-mail. No practice data is exposed.
3. **Hidden fields remain searchable.** `hiddenFields` strips values from responses, but `Patient?phone=...` still filters for the AI service: an existence oracle for hidden values.
4. **References are not validated.** Records may reference ids in another practice's project (or nothing). `Project.checkReferencesOnWrite` would refuse that, but billing writes references that do not resolve in Medplum (Encounter plan-of-care extension `CarePlan/<billing id>`), so enabling it breaks `saveNote` (verified live). Enable it once billing only writes resolvable references.
5. **Signing race (server guard, residual).** The guard reads the Encounter as last committed, so the signing transaction can still write the encounter's children. A child created by a *concurrent* transaction that commits while the signing transaction is in flight is not refused. The signed content hash (billing patch 0003) still detects it. Closing it fully would need a row lock on the Encounter (`SELECT ... FOR SHARE`) inside the writer's transaction, which requires a deeper upstream change.
6. **Guard scope is the lockable child types.** Condition, Procedure, Observation, ClinicalImpression, QuestionnaireResponse, DocumentReference and Composition are locked through their encounter. Other resources that reference an encounter (Claim, ChargeItem, ServiceRequest, MedicationRequest, CarePlan, Task, ...) are not, by design: billing writes Claims after signing.
7. **Project admin powers that the guard leaves alone.** A project admin can still set passwords and reset MFA of project users (`/admin/projects/setpassword`, `/members/:id/mfa/reset`), delete memberships, and edit a ClientApplication if its policy allows it. That lets it act *as* another member (still bound by that member's policy and by the guard, so signed content stays locked), which is why no day-to-day identity is a project admin.
8. **The super admin project is outside the guard.** Identities in the Medplum Super Admin project (the seeded admin, the provisioning client) are super admins: allowed, and audited for signed content. Keep that project to operations only.
9. **Binary overwrite by identities whose policy allows Binary update (CLOSED by the server guard).** The platform roles make Binary create/read only, but a policy-less project admin or client could `PUT Binary/<id>` behind a signed note: the note (`attachment.url = Binary/<id>`, no version) then resolved to forged bytes while its own history stayed at one version. The guard now makes every Binary write-once in a flagged project (update, delete, `$presigned-url?upload=true` → 403 `binary-immutable`; super admin = audited break-glass). Tests: `guard.test.ts` "Binary behind a signed note", `bypass.live.test.ts` "policy-less project admin". Residual: content kept outside a project Binary (external URLs, other resources) is not covered.
10. **Logical / other-element encounter references (CLOSED by the server guard).** The guard used to read only the literal `encounter.reference`, so `encounter: { identifier: ... }`, `context.encounter[].identifier`, or `Observation.focus → Encounter/<signed>` created new children (incl. a non-addendum preliminary note) on a signed encounter. The guard now scans every element for Encounter references, resolves logical references by `Encounter.identifier` in the project, and refuses non-literal `encounter` links (`encounter-reference-invalid`). Tests: `signed-lock.test.ts`, `guard.test.ts` "logical (identifier) and other-element", `adversarial.live.test.ts` "CLOSED (server guard): logical". Residual: consumers that resolve identifiers differently from a same-project token search; non-child resource types are not checked (item 6). `lock.ts` (the AccessPolicy side) still only sees the literal link; the server rule is the enforcement point.

### Provisioning findings fixed

- `provisionPractice` created projects **without** `features: ['transaction-bundles']` (only `createPracticeProject` set it), so CLI-provisioned practices ran transactions with batch semantics. `buildProject` now sets it and existing projects are repaired on the next run (other features kept).
- `POST /admin/projects/:id/client` writes the ClientApplication and its membership as two separate writes. A client left without a membership used to stop provisioning with an error; it is now repaired and a fresh secret is issued (the first one was never delivered).
- Crash safety: `test/provisioning/crash.test.ts` (fake) and `crash.live.test.ts` (real server) kill provisioning at every single write, rerun it, and require the same resources as a clean run with no duplicates, then a no-op third run. A crash after the integration client was created but before the output was saved loses that one-time secret: rerun with `--rotate-secret`.
- `upsertPracticePolicies` looked policies up with the prefix-matching `name` search; it now uses `name:exact`.

### Deployment settings (server config, not code)

For any non-dev deployment: `registerEnabled: false` (no self-service users/projects), a specific `allowedOrigins`, `rateLimitsEnabled: true`, leave `preCommitSubscriptionsEnabled` off unless option (b) above is adopted, and never enable the project feature `async-batch` without re-running these tests.
