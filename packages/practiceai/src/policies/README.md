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
   | Condition, Procedure, Observation, ClinicalImpression | only the lock label: `meta.security` `https://practiceai.example/fhir/CodeSystem/signed-content-lock#locked` | **see gap 1** |

2. `subject` cannot change, so a record cannot be moved to another patient.
3. An Encounter cannot be *created* finished or signed. It can only reach that state by the transition from an existing draft.
4. A DocumentReference with docStatus final needs `author` and `date`, and `relatesTo` may only use `appends`. `replaces`, `transforms` and `signs` are rejected, so no new document can supersede signed content.
5. An addendum (any DocumentReference with `relatesTo`) must be written `docStatus = final`, so it is locked from its first version; `docStatus = amended` also counts as signed. Without this a `preliminary` document that `appends` the note would be listed by the app as an addendum while staying editable.
6. Once written, a clinical child (Condition, Procedure, Observation, ClinicalImpression, QuestionnaireResponse, Composition: `encounter`; DocumentReference: `context.encounter`) cannot be re-linked to another encounter, and the link cannot be added or removed. This stops a draft Procedure being moved into an already signed encounter.
7. **Delete**: writeConstraint is not evaluated on DELETE, but DELETE is its own AccessPolicy interaction, and no PracticeAI policy grants it on clinical or financial types. The billing app never deletes; it retires draft lines as entered-in-error.

The live tests confirm every role, including the provider and the integration client, gets 403 on PUT, PATCH, status revert and DELETE of a signed Encounter, the note, the QuestionnaireResponse, and labelled Conditions and Procedures. Addenda are created as new final DocumentReferences. The original keeps exactly one version, and its vread output is identical to the signed content. A transaction that touches signed content is rolled back as a whole.

## Who bypasses AccessPolicy (tested on this build, `bypass.live.test.ts`)

| Identity | Result |
| --- | --- |
| Super admin (seeded admin, no policy) | **Bypasses.** It can revert and delete signed content. Use it only for provisioning and operations, never day to day. |
| ClientApplication or membership **without** an AccessPolicy | **Bypasses.** Legacy behavior gives it `'*'` with no constraints. Every client must be created with `accessPolicy` (`createRoleClient` does this). |
| ClientApplication **with** a policy (billing integration, AI) | Bound by the policy. The lock holds. |
| Project admin (`membership.admin = true`) with a restrictive policy | Ordinary FHIR writes still obey the policy. **But it bypasses** in three ways: (a) `POST /<type>/<id>/$expunge` permanently destroys a signed note and its history; (b) it can edit its own `ProjectMembership` to remove `accessPolicy`, then log in again with full access; (c) `POST /admin/projects/:id/client` can create an unrestricted ClientApplication. |

Consequences:

- **No day-to-day identity may be a Medplum project admin or super admin.** `practice_admin` is a normal member (`admin: false`). User management for a practice goes through the platform's provisioning flow: the billing app's platform-admin screens, which call `inviteRoleUser` or `createRoleClient` using an operations identity that is kept out of practice traffic.
- Project admins cannot change `Project.features`, but they can change `Project.setting` (for example `preCommitSubscriptionsEnabled`).

## Findings and gaps

1. **Condition and Procedure of an app-signed encounter (gap).** AccessPolicy criteria and FHIRPath cannot dereference `Procedure.encounter`, so the server cannot tell that the linked encounter is finished. The Encounter, QuestionnaireResponse and note are locked by their own status. Conditions and Procedures are locked only if the signing transaction stamps the lock label on them. `buildSignLockEntries([conditions..., procedures...])` produces the extra `PUT` entries, each guarded by If-Match. **The billing app's `signEncounter` (billing `src/lib/fhir/gateway-core.ts`) does not add them yet.** Until it does, `lock.live.test.ts` "KNOWN GAP" shows that an unlabelled Procedure stays writable by the integration client. The app's own `assertWritable` still guards traffic that goes through the app.
2. **Project admins and super admins bypass the lock** (see above). With policies alone, a hard guarantee holds only for identities that have a policy and are not admins.
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

### Known gaps (not fixable with AccessPolicies; each has a live test asserting today's behavior)

1. **New children on a signed encounter.** The provider and the integration client can still *create* a new Procedure, Condition, completed QuestionnaireResponse or final progress note whose encounter reference points at a finished encounter (HTTP 201). A write constraint only sees the written resource and cannot dereference `Procedure.encounter`. What is created is itself locked from birth when final, and the signed content hash no longer verifies, but billing's `getBillingContext` bills whatever `encounter=` returns without re-checking the hash. Billing patch `docs/medplum/patches/0003-billing-context-verifies-signed-hash.diff` makes it refuse (`SignedContentIntegrityError`); live test `tests/medplum-live/tamper.test.ts`. Server-side options (need an upstream change or a server config switch; see remainingIssues of the review): (a) a reference-aware write constraint, e.g. a `%resolve()` / `%encounter` variable resolved by `Repository.isResourceWriteable` through the caller's repo, so a policy can say `%after.encounter.resolve().where(status = 'finished').exists().not()`; or (b) a pre-commit Bot (`preCommitSubscriptionsEnabled` in server config + project setting) that rejects Condition/Procedure/Observation/QuestionnaireResponse/DocumentReference writes pointing at a signed Encounter.
2. **`Project/$init` is open to every authenticated identity** (upstream `projectInitHandler` has no super admin check). The AI service and integration ClientApplications can create empty projects; a project-scoped user can create a project for a new server-scoped User by e-mail. No practice data is exposed.
3. **Hidden fields remain searchable.** `hiddenFields` strips values from responses, but `Patient?phone=...` still filters for the AI service: an existence oracle for hidden values.
4. **References are not validated.** Records may reference ids in another practice's project (or nothing). `Project.checkReferencesOnWrite` would refuse that, but billing writes references that do not resolve in Medplum (Encounter plan-of-care extension `CarePlan/<billing id>`), so enabling it breaks `saveNote` (verified live). Enable it once billing only writes resolvable references.

### Provisioning findings fixed

- `provisionPractice` created projects **without** `features: ['transaction-bundles']` (only `createPracticeProject` set it), so CLI-provisioned practices ran transactions with batch semantics. `buildProject` now sets it and existing projects are repaired on the next run (other features kept).
- `POST /admin/projects/:id/client` writes the ClientApplication and its membership as two separate writes. A client left without a membership used to stop provisioning with an error; it is now repaired and a fresh secret is issued (the first one was never delivered).
- Crash safety: `test/provisioning/crash.test.ts` (fake) and `crash.live.test.ts` (real server) kill provisioning at every single write, rerun it, and require the same resources as a clean run with no duplicates, then a no-op third run. A crash after the integration client was created but before the output was saved loses that one-time secret: rerun with `--rotate-secret`.
- `upsertPracticePolicies` looked policies up with the prefix-matching `name` search; it now uses `name:exact`.

### Deployment settings (server config, not code)

For any non-dev deployment: `registerEnabled: false` (no self-service users/projects), a specific `allowedOrigins`, `rateLimitsEnabled: true`, leave `preCommitSubscriptionsEnabled` off unless option (b) above is adopted, and never enable the project feature `async-batch` without re-running these tests.
