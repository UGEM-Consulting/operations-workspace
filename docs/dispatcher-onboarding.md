# Dispatcher onboarding — foundation and access

## Data and permissions

`invitations` belongs to its creating manager (or administrator), stores optional expected email, the bound verified email, final manager-confirmed employment assignments, configurable Telegram requirement, SHA-256 token hash, and creation/expiry/opened/consumed/revoked/completed timestamps. A 32-byte random token is returned only once in the invitation URL. `dispatcher_applications` has a unique foreign key to its invitation and a responsible manager foreign key. Creation of both records and the initial audit event is transactional.

Managers see only their own invitations/applications. Administrators see all records; no broader manager grant/delegation mechanism is introduced. IT cannot access application/draft endpoints; it can access only the approved snapshot/checklist described in it-onboarding.md. Detail endpoints load assignments before owner/admin checks and return 404 for someone else's record. Applicant draft answers are excluded from staff listings, and staff detail views require submission. Applicants never become internal User records.

`application_activity` stores event, invitation, optional staff actor and timestamp; no token, verification code or field snapshots. Events cover invitation creation/revocation, verified access, draft saves and submission. Application changes and their activity events commit together. There is no editing or deletion of audit events through the API.

## State machine and concurrency

- INVITED → DRAFT → SUBMITTED.
- Draft saves keep DRAFT; correction saves keep CHANGES_REQUESTED.
- Milestone 4 extends review/correction transitions; see [manager review](manager-review.md).

The policy lives in `modules/onboarding/transitions.ts`. CHANGES_REQUESTED, RESUBMITTED, APPROVED and REJECTED are supported by the review migration. IT task progress is tracked on a separate request and does not overwrite manager approval state. Invitation COMPLETED means the application was submitted, not approved.

Draft saves carry an integer version. Stale saves return 409 instead of silently overwriting another tab's work. Revocation, save and submission serialize against the invitation row; submission produces exactly one submission event. The unique invitation foreign key prevents duplicate application rows. Submission requires first/last names, separate personal/work phones, both trimmed American names, any invitation-required Telegram and explicit accuracy confirmation, independently of frontend React Hook Form/Zod checks. Employment answers are supplied by applicants and can be flagged for corrections. Final manager-confirmed assignments are stored separately on the invitation during approval; applicant DTOs cannot overwrite those canonical assignments.

## Verified applicant access

Initial `/apply/[token]` access reveals no application or employment information. The visitor provides their personal email and token in a JSON POST body. An optional expected email must match. Open invitations remain unbound until the first successful verification; the invitation lock serializes competing claims, and every challenge is bound to its submitted email. Unknown/mismatched/expired/revoked/consumed tokens receive the same generic response shape and an opaque verification reference. A valid request creates a ten-minute challenge. In development/test, a trusted operator uses `npm run verification:demo -- <reference>` to issue a random eight-digit code to a private terminal. Only its hash is stored. No API exposes the code; the command refuses non-fictional addresses and production. This simulates delivery; it is not proof of control of a real email inbox.

Verification locks and consumes the challenge and initial invitation token, then regenerates a separate express-session applicant session. Challenges are single-use; only five verification attempts per challenge are allowed in 15 minutes. The invitation is never a permanent credential. `/apply/resume` uses application reference + invited email and a fresh challenge to regain access independently of the consumed token. The reference alone grants nothing. Corrections use the same independent resume verification and never a consumed invitation token.

Sessions use `applicant_sessions` and `applicant.sid` (development) / `__Host-applicant.sid` (production) with HttpOnly, host-only, SameSite=Lax, Path=/, Secure in production and one-hour absolute expiration. The applicant cookie is distinct from staff identity, even in the same browser. Each applicant operation reloads the session-bound application and checks invitation revocation plus the application access window (initialized to invitation expiry; extended 30 days for a correction request). No caller-supplied record ID selects which draft to read or write. Logout deletes the session; re-verification regenerates it. Existing staff sign-in, cookies and health remain unchanged.

## Boundary, abuse protection and operations

Both applicant and staff browsers use the existing allowlisted Next.js same-origin BFF. Applicant requests forward only the applicant cookie; staff requests forward only the staff cookie. NestJS still requires the server BFF secret. All mutations independently require exact Origin, JSON and the non-simple CSRF header in both Next.js and NestJS. No browser PostgreSQL access, localStorage authentication or third-party cookies are used.

PostgreSQL counters enforce 60 verification requests/minute globally, five begins per normalized email/15 minutes, five code attempts per challenge/15 minutes, 60 verification attempts/minute globally, 30 invitation creations per staff member/15 minutes and 60 saves per application/minute. Counter keys are hashed. Expired challenges are pruned when beginning verification; session pruning is handled by connect-pg-simple. Login's existing expired-counter pruning remains. These conservative demo quotas can affect legitimate users under abuse; a production edge limiter and scheduled retention/cleanup job are still needed.

Development incoming-request logs are disabled because invitation URL paths contain credentials. Apply pages set no-referrer and noindex; no analytics or third-party scripts are added. Hosting/CDN/proxy/APM request logs may still capture URL paths: configure redaction/exclusions for `/apply/*` before external use. Do not enable body/cookie/query logging or publish private terminal code output. All demo intake addresses must end in `@example.test`; other addresses are rejected even if NODE_ENV changes.

Production verification deliberately returns 503 and cannot issue codes. A future real email delivery implementation needs approved delivery, durable challenge expiry/attempt enforcement, failure handling without enumeration, contact recovery, edge rate limiting and retention policies. Do not deploy the local verification mechanism or relax its production guard. No emails, external resources, real identity documents or provisioning are implemented. Reviews/corrections are described in manager-review.md.

## Verification

Run default tests and PostgreSQL integration tests with `TEST_DATABASE_URL` naming a dedicated `_test` database. Tests intentionally truncate identity and dependent onboarding tables in that database. Coverage includes permission/CSRF boundaries, token hashing, enumeration resistance, production code refusal, expiry/revocation, draft versions/resume, server validation, concurrent duplicate submission, terminal state immutability, manager ownership/admin visibility, restricted-session separation and throttling. Never use a real environment as a test database.

Migration rollback drops the onboarding tables and their data; only exercise it on a disposable database or with an explicitly reviewed backup/recovery plan. Normal upgrade uses `npm run migration:run` without rollback. TypeORM synchronization/migrationsRun remain disabled. The explicit Render start:render wrapper applies pending migrations before starting the API; ordinary local start/dev and builds do not migrate.
