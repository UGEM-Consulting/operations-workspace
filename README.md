# Operations Workspace

The workspace supports simple invitation links, verified applicant claiming, manager review, approval/rejection, field-specific correction requests and secure resubmission to the existing Operations Workspace foundation. Next.js handles presentation and a same-origin server boundary; NestJS owns authentication, permissions, user management, and PostgreSQL. IT provisioning, external messaging, identity-document uploads and reopening closed applications remain out of scope. Applicants are not internal staff users.

## Stack and architecture

Node.js 24 LTS, npm workspaces, Next.js 16 App Router, React 19, strict TypeScript, Tailwind CSS 4, shadcn/ui conventions and local Button/Card components, NestJS 11, TypeORM 0.3, and PostgreSQL 16. One root lockfile pins the installed dependency graph. Next.js uses its supported Webpack compiler for development and production because Turbopack worker port binding is restricted in the initial verification environment. Next.js 16.4.2 was the stable npm release at setup. NestJS 11 is used for compatibility with the TypeORM/config integrations.

Next.js renders the UI and calls NestJS from a server-only helper. NestJS exclusively owns business logic and database access. The dashboard streams a loading state, requests `/api/health` without caching, times out after five seconds, and shows unavailable status for HTTP errors, invalid responses, and network failures. Check again refreshes server-rendered status. Health queries PostgreSQL and returns 503 on failure. The API requires a working database at startup.

```text
apps/web/src/
  app/          Routes and workspace layout
  components/   Shell, theme controls, local shadcn/ui components
  features/     Dashboard, authentication, user-management and onboarding UI
  lib/          Server-only API/auth helpers and BFF transport policy
apps/api/src/
  common/       Global validation, prefix, CORS
  config/       Environment validation
  database/     TypeORM runtime/CLI config and migrations
  modules/      Health, auth/session, internal users, onboarding
packages/shared/  Reserved for future transport types
```

## Local setup

Use Node 24 LTS (`nvm install && nvm use`), npm 10+, and PostgreSQL 16 (native or Docker Compose). Run from the repository root:

```sh
npm ci
npm run setup:local
# Start PostgreSQL if not already running natively:
docker compose up -d postgres
npm run migration:run
npm run seed:demo
npm run dev
```

`setup:local` creates missing application environment files, generates separate random session/BFF secrets and random demo passwords, and preserves existing nonempty values. Files are Git-ignored. Read the generated credentials privately in `apps/api/.env`; passwords are never printed. If you previously copied the example containing `ALLOW_DEMO_SEED=false`, explicitly change it to `true` for this local demo. The seed is idempotent: existing accounts are never reset, reactivated, or promoted. It refuses production, non-`example.test` addresses, duplicate demo emails, and missing/short passwords. Do not use this script against real employees or production databases.

| Fictional account | Local default email | Landing page |
| --- | --- | --- |
| Avery Demo — System Administrator | admin@example.test | /dashboard |
| Morgan Demo — Dispatcher Manager | manager@example.test | /onboarding |
| Taylor Demo — IT Specialist | it@example.test | /it/tasks |

Open http://localhost:3000/login. API health: http://localhost:4000/api/health. Development Swagger: http://localhost:4000/api/docs. Restart the development processes after changing environment files. Both apps must use the same `BFF_SHARED_SECRET` and `WEB_ORIGIN`.

For native PostgreSQL, create a local role/database once with your PostgreSQL administrator:

```sql
CREATE ROLE operations WITH LOGIN PASSWORD 'operations';
CREATE DATABASE operations OWNER operations;
```

These database credentials are fictional development defaults. Adjust `DATABASE_URL` for your installation. Do not start Docker on port 5432 if native PostgreSQL already uses it. Docker data persists in a named volume; `docker compose down` stops the container without deleting data.

## Authentication and permissions

Authentication uses [express-session](https://github.com/expressjs/session), [connect-pg-simple](https://github.com/voxpelli/node-connect-pg-simple), and [Argon2id](https://github.com/ranisalt/node-argon2) (64 MiB, three iterations, one lane). Session IDs and signing are handled by the established library. PostgreSQL stores sessions; MemoryStore is used only in a cookie-options unit test. Login regenerates the session ID, records the user ID/version and absolute expiry, and updates `lastLoginAt`. Logout destroys the stored session. Expired, revoked, missing, disabled, and stale-version sessions are rejected.

Every protected request reloads the user from PostgreSQL. User edits increment an authentication version and delete all their sessions, including password and role changes. Version checking also prevents an in-flight login from restoring access after an administrative change. Users cannot remove their own administrator access; serialized administrator updates preserve the last active administrator. Administrator settings support account creation, names/email/role/status changes, and password resets. No registration or public password-reset endpoint exists. User lists are capped at 200 for the demo.

| API/page scope | SYSTEM_ADMIN | DISPATCHER_MANAGER | IT_SPECIALIST |
| --- | --- | --- | --- |
| Current user, logout, dashboard | Yes | Yes | Yes |
| Onboarding invitations/applications | Yes | Yes | No |
| IT placeholder | Yes | No | Yes |
| Settings and user administration | Yes | No | No |

A global NestJS guard requires authentication and explicit role metadata; endpoints without a role policy are denied. Health, login, logout and applicant routes are explicitly public to the staff guard. Applicant record routes independently enforce restricted applicant sessions. Login/logout still require the BFF boundary and CSRF checks. The API returns permitted navigation and role landing destinations. Next.js uses those results and calls API page authorization endpoints rather than copying the permission matrix. `canAccessAssignedApplication` provides a tested foundation requiring a database-loaded assignment for managers; future controllers must invoke it after loading records. Onboarding record endpoints enforce this policy against database assignments.

## Same-origin cookies and CSRF

The browser calls only `/api/backend/...` on the Next.js origin. This narrow allowlisted proxy forwards to NestJS with a server-only shared secret and only the session cookie. It forwards NestJS `Set-Cookie` back to the browser without a Domain attribute. The cookie therefore belongs to the Vercel frontend, not the Render domain; third-party cookies are unnecessary. Server Components forward the same cookie directly to NestJS. No tokens are stored in localStorage or exposed through client environment variables.

Production cookie: `__Host-operations.sid`, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Local HTTP development uses `operations.sid` with Secure=false. Default absolute expiry is eight hours, configurable from one minute to 24 hours. Touch/rolling extensions are disabled. PostgreSQL prunes expired session rows periodically. Use HTTPS and `NODE_ENV=production` on both hosted applications. A local production frontend (`next start`) also requires production-compatible API cookie settings and HTTPS; use `npm run dev` for normal HTTP localhost testing.

All state-changing requests, including login/logout, require an exact configured Origin, JSON content type, and `X-CSRF-Protection: 1`. The BFF also rejects a cross-site `Sec-Fetch-Site` value. Cross-origin HTML forms cannot satisfy this non-simple-header contract; cross-origin fetch preflights are not allowed by the BFF. NestJS independently enforces the Origin/header/JSON checks plus the server-only BFF key. The BFF never trusts a client-supplied BFF key, forwarding protocol, destination URL, or arbitrary API path. SameSite is additional protection, not the only CSRF defense. Tests cover login CSRF, authenticated mutations, logout CSRF, direct API bypass, and the BFF allowlist. CORS is not authorization and browser-to-Render credentialed CORS is not used.

Login uses atomic PostgreSQL counters: at most five attempts per normalized email in 15 minutes and 60 attempts across the service per minute. Counters persist across restarts and API instances; successful attempts also count. Account keys are SHA-256 digests. Expired counter rows are pruned during login. No untrusted proxy IP is used. This deliberately conservative demo policy can deny legitimate logins during abuse; production should add an edge/WAF limiter and operational monitoring rather than trusting arbitrary forwarded IP headers.

## Environment variables

The root `.env.example` is a reference only. NestJS loads `apps/api/.env`; Next.js loads `apps/web/.env.local`. Never commit secrets or use `NEXT_PUBLIC_` for these values.

| Variable | App | Meaning |
| --- | --- | --- |
| NODE_ENV | API | development/test/production |
| PORT | API | Default 4000; Render supplies its port |
| DATABASE_URL | API | Secret PostgreSQL URL |
| DATABASE_SSL | API | false for local/private Render connection; true verifies TLS for external DB |
| CORS_ORIGINS | API | Comma-separated exact HTTP(S) origins, no trailing slash/wildcards |
| SESSION_SECRET | API | Required random secret of at least 32 characters; rotation invalidates cookies |
| BFF_SHARED_SECRET | Both servers | Required separate random secret, identical in Next.js and NestJS; at least 32 characters |
| WEB_ORIGIN | Both servers | Exact frontend origin, no trailing slash; HTTPS required for production API |
| SESSION_TTL_SECONDS | API | Absolute session lifetime, default 28800 |
| API_BASE_URL | Web server | Backend origin without `/api` |
| ALLOW_DEMO_SEED | Seed only | Explicit true required; never production |
| DEMO_ADMIN_EMAIL/PASSWORD | Seed only | Fictional admin credentials |
| DEMO_MANAGER_EMAIL/PASSWORD | Seed only | Fictional manager credentials |
| DEMO_IT_EMAIL/PASSWORD | Seed only | Fictional IT credentials |
| TEST_DATABASE_URL | Integration tests only | Dedicated disposable database whose name ends in `_test` |

Use separate secrets/environments for previews and production. Avoid `?sslmode=` options in DATABASE_URL that conflict with the explicit `DATABASE_SSL` certificate-verification policy. Secrets and sensitive request/database error details are not logged.

## Commands and tests

```sh
npm run dev                  # Both apps, stops both on Ctrl+C
npm run dev:web
npm run dev:api
npm run typecheck
npm run lint
npm test                     # Unit/security/health tests; database suite skipped without TEST_DATABASE_URL
npm run build                # Both independent production builds
npm run build --workspace=@operations/web
npm run build --workspace=@operations/api
```

Run real PostgreSQL authentication tests against a separate disposable database, never application data:

```sh
createdb -O operations operations_m2_test
# Supply a connection URL for that disposable database through the environment:
TEST_DATABASE_URL="postgresql://operations:operations@localhost:5432/operations_m2_test" npm test
```

The database suites apply migrations and truncate identity and dependent onboarding tables in the explicitly selected test database. It covers all roles, invalid credentials, disabled/SSO-only users, session expiration and revocation, logout replay, login throttling, deny-by-default policies, privilege escalation, CSRF, user creation, case-insensitive duplicate email rejection, and idempotent demo seeding. Passwords and secrets for tests are generated at runtime. BFF CSRF and allowlist helpers are also unit-tested. Test databases must be managed independently from the app database.

## Migrations

Runtime and CLI share TypeORM options. `synchronize=false`, `migrationsRun=false`, and automatic extension installation is disabled. PostgreSQL 16 provides `gen_random_uuid()` without an extra extension. The identity migration creates users, enum types, a unique normalized-email index, sessions, and login counters. The onboarding migration adds invitations, applications, applicant verification challenges/sessions and activity events.

```sh
npm run migration:run
npm run migration:generate -- src/database/migrations/DescribeChange
# Destructive rollback: only after reviewing data impact/backups:
npm run migration:revert
# For built deployments:
npm run migration:run:prod --workspace=@operations/api
```

Migration generation paths are relative to `apps/api`. Run migrations explicitly before starting schema-dependent releases, never during builds. The identity rollback drops identity data and is intended for disposable verification databases or carefully reviewed recovery.

## Vercel and Render (manual deployment only)

No cloud resources or production accounts have been created. Deployment requires approval. The optional `render.yaml` blueprint can create billable resources.

1. Render API: keep root directory at repository root; Node 24; build `npm ci --include=dev && npm run build --workspace=@operations/api`; start `npm run start --workspace=@operations/api`. Use the internal PostgreSQL URL, explicit CORS origin, and `/api/health` as health check. Before the first release, run `npm run migration:run:prod --workspace=@operations/api` in a controlled deployment step.
2. Set API `NODE_ENV=production`, a strong `SESSION_SECRET`, a separate `BFF_SHARED_SECRET`, `WEB_ORIGIN=https://your-workspace.vercel.app`, and `SESSION_TTL_SECONDS`. Never put these secrets into tracked YAML. Production Swagger is blocked by the BFF boundary and is not proxied to browsers.
3. Vercel: root `apps/web`, Next.js preset, Node 24, enable inclusion of files outside the root for the workspace lockfile. `vercel.json` installs from the repository root and builds only web. Set server-only `API_BASE_URL=https://your-api.onrender.com`, matching `BFF_SHARED_SECRET`, and exact `WEB_ORIGIN=https://your-workspace.vercel.app`.
4. Browser cookies remain on the Vercel domain; the BFF adds the trusted forwarding protocol after verifying browser origin. Do not enable direct cross-site session cookies or credentialed CORS. Use a dedicated preview API/environment with matching origin for preview deployments rather than wildcard origins.
5. Auto-deploy is off in the blueprint; disable Blueprint Auto Sync separately if manual configuration sync is required. Production account provisioning is deliberately outside this demo seed and requires an approved administrative process. Do not relax the seed's production guard.

See [Vercel monorepos](https://vercel.com/docs/monorepos) and [Render blueprint configuration](https://render.com/docs/blueprint-spec). Review [identity architecture](docs/identity-architecture.md) for invitation and Google Workspace SSO preparation.

## Dispatcher invitation demo

After updating an existing checkout, run `npm ci`, `npm run migration:run`, then restart both development servers with `npm run dev`. Existing staff accounts and sessions are preserved; the new review migration adds decision/submission history and backfills existing submissions. The local development database has already been migrated during this implementation.

1. Sign in as `manager@example.test` using the generated password in `apps/api/.env`.
2. Open **Invitations → Create Invitation**. No applicant details are required. Under **Optional settings**, you may enter an expected fictional email or change the seven-day expiration (1–30 days).
3. Copy the unique link immediately. Only its hash is stored, so the link cannot be recovered from the listing later. Revoke and create another invitation if you lose it.
4. Open the link and enter a fictional personal email such as `applicant@example.test`. If the manager specified an expected email, it must match exactly after normalization. Request verification and copy the displayed reference. The invitation is claimed only after successful verification; competing applicants cannot claim it afterward.
5. In a private local terminal run:

   ```sh
   npm run verification:demo -- <verification-reference-uuid>
   ```

   Enter the eight-digit code in the applicant page. This explicit terminal command simulates email delivery only for fictional `example.test` addresses in development/test. Codes are never returned by the API or printed in server logs. Do not run this command in CI or forward its output to logs.
6. Save the displayed application reference. Complete the personal and employment sections, including MC/Independent, team lead/Independent and job title. Save a draft, review and confirm accuracy, then submit. The verified email is read-only; it cannot be swapped for another applicant.
7. Return to the manager's Applications page to see the submission and open its details. Reload an already-open manager page to see newly submitted records.

Applicant sessions last one hour and use a separate HttpOnly cookie. To resume later, visit `/apply/resume`, enter the application reference and invited email, then obtain a fresh verification code. Initial applicant access expires with the invitation; a correction request grants a separate 30-day application access window. Revocation and applicant-session expiration still block access. Links default to seven days (1–30 days supported). Telegram can be required per invitation. Applicants provide employment details, while managers confirm the authoritative assignments before approval. Identity-document controls remain placeholders only.

No additional secrets or environment variables are needed. `NODE_ENV=production` blocks the local code command **and both verification endpoints**. Production email verification delivery is intentionally not configured; this milestone is a local fictional demo, not a deployable real-applicant intake service. See [dispatcher onboarding architecture](docs/dispatcher-onboarding.md) for transitions, isolation, throttling and deployment requirements.

## Manager review and applicant corrections

The Onboarding dashboard now shows awaiting review (SUBMITTED + RESUBMITTED), changes requested, resubmitted, approved and rejected counts across the manager's entire scope. Application review supports name/email/MC/team-lead/reference search, status filters, sorting and 10/20/50-row pages. SYSTEM_ADMIN sees all records; managers only see their own assigned records. IT cannot access applicant records or review actions yet.

Open a submitted application's review page to view submitted information, decisions, reviewer identity, comments, old/new resubmission values and an activity timeline. Approval and rejection require explicit confirmation. Approval also requires confirmation of final MC, team lead and job title; the manager may correct those values in the approval dialog. Rejection and correction requests require a reason; corrections also require at least one flagged personal field. The correction dialog clearly identifies applicant-visible instructions; approval/rejection comments remain internal. Approved/rejected applications cannot be edited or reopened, including by administrators.

For a complete fictional demo:

1. Create an invitation and submit the application using the invitation walkthrough above.
2. As the manager, open **Applications → Review details → Request changes**. Supply an applicant-facing reason and flag fields such as phone or Telegram.
3. As the applicant, visit `/apply/draft` and select **Check status**, or visit `/apply/resume` and use a fresh verification code. A consumed invitation token is never reused for corrections.
4. Update only the highlighted fields. **Save corrections** retains CHANGES_REQUESTED; **Resubmit application** moves it to RESUBMITTED.
5. The manager sees the resubmission in the dashboard, compares previous/submitted values, and approves with confirmation. The approved record is ready for Milestone 5; no provisioning tasks or external accounts are created.

Correction drafts remain private to the applicant until resubmission. First/last names, personal/work phone numbers, American names, Telegram, MC, team lead and job title can be flagged. Verified email cannot change. Applicant employment answers remain distinct from the manager-confirmed assignments recorded at approval. A correction request grants 30 days of application access independently of invitation-token expiry, without extending the one-hour applicant session. Reverification is still required after session expiry. Production email verification remains disabled.

The application status is the single source of truth. Review decisions record reviewer ID, prior/new status, reason, selected fields and a timestamp. Submitted revisions preserve comparison data separately from metadata-only audit events. Review/submission events are durable and notification-ready; the dashboard and applicant status page are the MVP notifications. No email, Telegram message or external notification is sent.

## Review migration and repeatable verification

`1792620000000-ApplicationReview.ts` extends review statuses and records history. `1792630000000-OptionalInvitationDetails.ts` makes invitation details optional, separates expected/verified email, binds challenges to an email, preserves legacy employment details in working/submitted fields, and adds employment confirmation history. Existing records and approval states are preserved. No schema synchronization or automatic migration execution is enabled. Run `npm run migration:run` before starting the updated API. This local development database was migrated during implementation; no production database was changed.

Rollback refuses if review decisions or advanced states exist; it will not silently turn approvals/rejections back into submitted records. Restoring a pre-review production schema requires a separately reviewed recovery plan.

After `npm run build`, the following reproducible checks are available from the repository root:

```sh
# Creates one fictional local application, then exercises the full HTTP workflow.
# Requires both development servers on localhost:3000/4000 and seeded demo accounts.
ALLOW_LOCAL_REVIEW_SMOKE=true node scripts/review-smoke.cjs

# Destructive: only a dedicated LOCAL disposable database ending in _test.
ALLOW_DISPOSABLE_DB_RESET=true TEST_DATABASE_URL="postgresql://operations:operations@localhost:5432/operations_m2_test" node scripts/review-migration-check.cjs
```

The migration check verifies rollback/reapplication, preservation/backfill of existing submissions, and refusal to discard review decisions. The smoke test deliberately leaves a fictional approved record visible to the demo manager. Never point tests at a real environment or forward secrets/verification output to logs. See [manager review architecture](docs/manager-review.md) for lock ordering, access rules and Milestone 5 preparation.

## Verification and remaining concerns

Verification covers 81 tests, including all existing authentication/invitation regressions and the full submitted → changes requested → correction draft → resubmitted → approved integration flow. It also covers rejection privacy, required reasons/confirmations, immutable terminal states, cross-manager and IT denial, stale/concurrent decisions, field restrictions, fresh verification after invitation expiry, queue pagination/search and review throttling, concurrent invitation claiming, optional expected-email restrictions and confirmed employment assignments. Type checks, warning-free lint, frontend/backend production builds and the default non-database test run all passed.

A real Next.js BFF HTTP smoke test passed the complete invitation-to-approval workflow, including fresh returning verification, manager/applicant views, submitted comparisons, private correction drafts, query forwarding, terminal state and health. The browser tool still could not initialize, so responsive visual checks, keyboard dialog interactions and full browser form behavior require manual QA. HTTP tests do not replace these checks.

No dependencies were added or upgraded for invitation simplification. The previous full audit reported 26 unresolved findings (21 moderate, five high) in existing transitive tooling chains and Swagger's YAML chain; no forced audit fixes were applied. Before real deployment, address the documented dependency advisories, approved email delivery, invitation URL redaction, retention of submission revisions/comments, edge rate limits and scheduled cleanup. No cloud resources or external messages were created.

## Optional invitation details and compatibility

A new invitation is unclaimed: expectedEmail optionally restricts who can claim it, while email is set only after a successful verification. Challenge creation does not reserve the invitation. Verification rechecks the invitation under a row lock and atomically binds the first verified identity; losing claimants receive a generic verification error. Token hashes, expiry, revocation, manager ownership, unique application creation, CSRF and database-backed restricted sessions remain in place.

Legacy invitation email restrictions, employment details, drafts, submissions, reviews, approvals and pending verification challenges are preserved by the additive migration. Deprecated employment fields on the creation API are accepted as optional prefills for older clients; the manager UI no longer asks for them. New approvals require `employmentConfirmed: true` and an `employment` object containing MC, team lead and job title. This intentional API validation change prevents an approval from skipping assignment confirmation. Previous approvals are not reopened or invalidated.

The approval transaction writes final assignments to the existing invitation columns used by the IT-ready record contract and records previous/final assignments in review history. Applicant-submitted values stay intact for comparison. There are currently no implemented IT provisioning workflows to migrate; the existing APPROVED/readyForIt contract is preserved.

After a production build, verify migration compatibility only on a dedicated local disposable database:

```sh
ALLOW_DISPOSABLE_DB_RESET=true TEST_DATABASE_URL="postgresql://operations:operations@localhost:5432/operations_m2_test" node scripts/invitation-migration-check.cjs
```

This verifies preservation of legacy identities, drafts/submissions, reviews, approved states and challenges; rollback/reapplication; and refusal to discard new simplified invitation data. The existing review migration script was updated to account for the new migration. The HTTP smoke script now creates an invitation with no details, claims it, completes employment, saves/resumes, resubmits corrections and approves with confirmed assignments. Production verification still fails closed until approved delivery is implemented; no development-only verification code is exposed in production.

## Local verification troubleshooting

Use an `@example.test` fictional personal email in the applicant page. If the manager set an expected email, it must match. Other domains are rejected with a clear local-demo explanation. A generic verification reference does not by itself guarantee that the invitation matched; unknown/mismatched addresses and unavailable links never reveal applicant details.

The terminal command reports when a reference is missing, expired, already used, or has no available invitation. Click **Start again** for a fresh reference, or use `/apply/resume` with the verified email/application reference after the invitation has been consumed. For database/configuration errors, check `apps/api/.env`, PostgreSQL and migrations. Raw connection errors and secrets are never printed. Production verification remains disabled.

## Required dispatcher contact and American names

The application now requires `firstName`, `lastName`, `personalPhoneNumber`, `workPhoneNumber`, `preferredAmericanFirstName`, and `preferredAmericanLastName`, in addition to the existing employment requirements. Labels are **First Name**, **Last Name**, **American First Name**, and **American Last Name**. American names are trimmed and whitespace-only values are rejected at submission and approval. Incomplete drafts may still be saved.

Both phone fields are separate. International formatting is accepted: optional leading `+`, spaces, parentheses, dots and hyphens, with 7–15 digits and at most 40 total characters. Frontend Zod, NestJS DTO validation and merged-field validation enforce the same structural contract; this does not verify carrier ownership or infer a country. No personal phone is copied into the work-phone field.

`1792640000000-ApplicantRequiredDetails.ts` maps existing JSONB `phone`, `preferredFirstName` and `preferredLastName` values to the canonical field names in application drafts and submitted revisions, preserving the original values/keys. It also maps historical correction field identifiers. It never invents work numbers or names, changes statuses, or invalidates historical approvals. The TypeORM entity's existing JSONB field contract is extended rather than introducing conflicting copies in separate columns.

Existing records missing required details remain viewable. New submission/resubmission or approval requires completion. Managers can request corrections to the new fields; required missing/invalid fields are included automatically. Existing correction rounds also allow completing newly required fields from the last submitted revision, and those fields remain editable while corrections are saved. Saved correction answers remain private until resubmission. Existing APPROVED applications remain approved even if they lack newly required data; their details show missing information without reopening them.

Manager review, applicant review summaries and correction forms show both phones and both American names. The authorized review response includes `itDetails`, with the legal first/last names retained separately and an American-name-based `proposedDisplayName`. No display name is proposed when either American name is missing; legal names are not substituted or overwritten. This prepares future IT onboarding data and does not provision accounts or expand IT access.

After building, verify this migration only on a disposable LOCAL test database:

```sh
ALLOW_DISPOSABLE_DB_RESET=true TEST_DATABASE_URL="postgresql://operations:operations@localhost:5432/operations_m2_test" node scripts/application-details-migration-check.cjs
```

Rollback restores legacy field identifiers and keeps canonical JSON values, including collected work numbers, so data is not discarded. Reapplication is safe. Existing review/invitation migration checks were updated for the additional migration. Verification includes frontend/backend validation, missing/blank values, international/invalid phones, separate phone preservation, corrections to required fields, legacy approval access, migration rollback/reapply, and the full Next.js HTTP workflow. Browser visual/keyboard QA remains manual when browser automation is unavailable. No dependencies were added, external services configured, or cloud deployments performed.
