# UGEM Workspace

The workspace supports simple invitation links, verified applicant claiming, manager review, approval/rejection, field-specific correction requests and secure resubmission to the existing UGEM Workspace foundation. Next.js handles presentation and a same-origin server boundary; NestJS owns authentication, permissions, user management, and PostgreSQL. Manual IT onboarding checklists and manager completion notices are implemented. New hires upload a selfie and an ID selfie and e-sign the company NDA/SOP during the application ([onboarding documents](docs/onboarding-documents.md)). External provisioning/messaging and reopening closed applications remain out of scope. Applicants are not internal staff users.

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

Use Node 22.12+ (22.x) or Node 24 LTS (`nvm install && nvm use` selects 22.12.0 locally), npm 10+, and PostgreSQL 16 (native or Docker Compose). Run from the repository root:

```sh
npm run setup:dependencies
npm run setup:local
# Start PostgreSQL if not already running natively:
docker compose up -d postgres
npm run migration:run
npm run seed:demo
npm run dev
```

Development commands accept Node 22.12+ (22.x) and Node 24.x. `npm run setup:dependencies` runs `npm ci` with the macOS SDK headers configured on Node 22 before dependency install scripts execute. Use it for clean local installs: plain `npm ci` can fail before the root hook on Macs whose compiler cannot find C++ headers. On macOS with Node 22, the root install hook checks whether Argon2 loads and rebuilds it from the same package source only if the shipped native binary fails. This uses the installed Xcode Command Line Tools, Python and Node headers; the first repair may download headers. Web-only installations without Argon2 and other runtimes/platforms are unchanged. If installation scripts were skipped, run `npm run repair:native` from the root before starting the API. The helper explicitly includes the installed macOS SDK C++ headers when available. This follows Argon2’s [documented source-build option](https://github.com/ranisalt/node-argon2#faq), without changing Argon2id parameters, hashes, accounts or sessions.

If the web reports “The authentication service is unavailable” and the API compiles but never listens, stop the development command, run `npm run repair:native`, then restart `npm run dev`. Compilation success alone does not mean the API is listening. If the error persists, check API startup and local PostgreSQL availability; do not bypass session verification. Production deployment instructions below retain Node 24; no cloud runtime was changed.

Node 22.12.0 validation: clean dependency installation, type checks, lint, 42 enabled tests, both production builds and a local API/PostgreSQL health check passed. The 67 database integration tests were not selected. Cross-runtime Argon2id verification passed between Node 22.12.0 and Node 24, including incorrect-password rejection. The existing transitive lint package `eslint-visitor-keys@5.0.1` declares Node 22.13+ and emits an npm engine warning on 22.12.0; lint runs successfully here, but that dependency does not officially support this exact minor version. No dependency versions, password parameters or database records were changed.

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

Staff with two-step verification (always administrators) complete a second step after the password; see [staff two-step verification](#staff-two-step-verification).

Every protected request reloads the user from PostgreSQL. Email, role, status and password changes increment an authentication version and delete all of the user's sessions, including half-signed-in ones; name-only edits keep them. Version checking also prevents an in-flight login from restoring access after an administrative change. Users cannot remove their own administrator access; administrator creates and updates take the same advisory lock, recheck that the actor is still an active administrator and preserve the last active administrator. Administrator settings support account creation, names/email/role/status changes, and password resets. No registration or public password-reset endpoint exists. User lists are capped at 200.

**Passwords.** Staff passwords are 12–128 characters. A password an administrator sets (new account or reset of someone else) is temporary: `users.mustChangePassword` is set, and a correct password then creates only a pending session (`mfaPending` stage `password`, 10 minutes, no `userId`) that reaches only `POST /auth/password` (`@AllowPendingPasswordChange`); the login response is `{ stage: 'password', landingPage: '/login/password' }`. Choosing a new password continues to the authenticator step or the workspace. The guard also rejects a full session while the flag is set. Staff change their own password under **Account security**: the current password is required, the new one must differ, attempts are limited to five per user per 15 minutes, and every other session ends while the acting one continues under a new session ID. The bootstrap administrator and demo seed accounts chose their passwords, so they are not forced to change them. An administrator still knows a temporary password until the user replaces it; a future one-time setup link would remove administrator-known passwords entirely.

**Audit.** `staff_security_events` also records `USER_CREATED`, `USER_NAME_CHANGED`, `USER_EMAIL_CHANGED`, `USER_ROLE_CHANGED`, `USER_STATUS_CHANGED`, `USER_PASSWORD_SET` (actor = administrator) and `PASSWORD_CHANGED` (self-service, `forced` flag) in the same transaction. Rows hold the changed field names and whether sessions ended, never values. Migration `StaffPasswordChange1792760000000` adds the flag (default false, previous-version compatible); its rollback refuses while any change is pending. Deploy the web app before the API: older web builds would send a forced user to the missing `/login/password` page.

| API/page scope | SYSTEM_ADMIN | DISPATCHER_MANAGER | IT_SPECIALIST |
| --- | --- | --- | --- |
| Current user, logout, dashboard | Yes | Yes | Yes |
| Onboarding invitations/applications | Yes | Yes | No |
| Approved IT onboarding requests/checklists | Yes | No | Yes |
| Staff accounts and Settings | Yes | No | No |
| Account security (own two-step verification) | Yes | Yes | Yes |

A global NestJS guard requires authentication and explicit role metadata; endpoints without a role policy are denied. Health, login, logout and applicant routes are explicitly public to the staff guard. Applicant record routes independently enforce restricted applicant sessions. Login/logout still require the BFF boundary and CSRF checks. The API returns permitted navigation and role landing destinations. Next.js uses those results and calls API page authorization endpoints rather than copying the permission matrix. `canAccessAssignedApplication` provides a tested foundation requiring a database-loaded assignment for managers; future controllers must invoke it after loading records. Onboarding record endpoints enforce this policy against database assignments.

## Staff two-step verification

Staff can protect sign-in with an authenticator app (TOTP, RFC 6238: Google Authenticator, Microsoft Authenticator, 1Password and similar) using the maintained [otpauth](https://github.com/hectorm/otpauth) library; the enrolment QR code is rendered server-side with [qrcode](https://github.com/soldair/node-qrcode). Applicants are out of scope.

- **Methods.** An authenticator app, or email codes sent to the account email. Administrators must use an authenticator app; everyone else chooses during setup. Email codes are six digits, work once, expire after 10 minutes and are tied to what they were sent for (signing in, setting up, or confirming an Account security change). "Send a new code" is available after 30 seconds, with at most five emails per person per 15 minutes. Making someone an administrator removes an email-code setup, so they set up an authenticator at their next sign-in. Email codes need `EMAIL_DELIVERY=smtp` and their own sender, `STAFF_EMAIL_FROM` (never the onboarding address); without them only authenticator apps are offered.
- **Who must use it.** `SYSTEM_ADMIN` always. Administrators can raise the requirement to all staff under **Settings → Two-step verification**; it cannot be lowered below administrators. Other roles may turn it on (or off, with a current code) under **Account security**.
- **Sign-in.** A correct password for an enrolled user creates only a pending session (`mfaPending`, 10 minutes, so an emailed code can arrive) with no `userId`, so the global guard grants no staff route. Routes marked `@AllowPendingMfa('verify')` accept it; a correct code regenerates the session ID and grants normal access. A required user who has not enrolled gets a pending enrolment session (15 minutes) that reaches only the enrolment routes: the QR code and manual key, then one code to confirm. There is no grace period. The services re-read the pending stage, expiry, user and `authVersion` rather than trusting the route decorator; enrolment without a pending session requires a full session (voluntary enrolment). A required password change comes first (see [authentication](#authentication-and-permissions)).
- **Recovery codes.** Confirming enrolment issues ten single-use `XXXXX-XXXXX` codes, shown once and stored only as Argon2id hashes. Each signs in once; regenerating needs a current authenticator code and cancels the old set.
- **Protection.** Secrets are AES-256-GCM encrypted with `MFA_ENCRYPTION_KEY`, bound to the user ID, and never logged or returned after enrolment. Codes for the current and the previous 30-second step are accepted (otpauth's window is symmetric; a match on the next step is discarded). Each accepted step is recorded, so a code cannot be replayed. Five wrong codes for a user within 15 minutes, across all sessions and API instances, lock the second step (`429`, also for correct codes) and record one `MFA_LOCKED_OUT` with the lock length. A repeat lockout lasts 1 hour instead of 15 minutes, never longer, so someone who knows a password cannot cheaply keep an administrator out. The series resets after a day without a lockout or with an administrator reset. There is deliberately no permanent lock, which would let anyone who knows a password lock out the last administrator; no email or notification is sent.
- **Sessions.** Turning MFA on or off, or an administrator reset, increments `authVersion` and deletes all of the user's sessions (pending ones too); the acting session is re-established. A session without a completed second step stops working once the user enrols or their role or policy requires MFA. That includes sessions created before this feature, so administrators sign in again once after the release.
- **Administrator reset.** For someone who lost both their phone and recovery codes: **Settings → Two-step verification → Reset**. Confirm the person's identity outside the workspace first. Administrators never see secrets or codes, cannot reset themselves, and the reset ends the user's sessions; a required user enrols again at the next sign-in. Role/status rules and the last-active-administrator protection are unchanged.
- **Audit.** `staff_security_events` records enrolment, disable, admin reset (with actor), recovery-code use (remaining count), regeneration, lockout and policy changes. Rows hold metadata only, never codes, secrets or session IDs.

**Deploying.** Generate the key privately (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) and store it in Render's API environment as `MFA_ENCRYPTION_KEY` plus a private backup (for example the company password manager); never commit it. Deploy the web app (Vercel) first: it understands both the old and the new login responses. Then deploy the API, whose `start:render` applies the additive `StaffMfa1792720000000` migration. Every administrator is then asked to set up an authenticator at the next sign-in. Losing or changing the key makes every enrolled authenticator unusable: an administrator would need to reset everyone. Key rotation is not implemented yet. The migration rollback refuses while any enrolment, recovery code or security event exists.

**Locked-out last administrator.** Recovery codes are the self-service path. If the only active administrator loses both, there is currently no in-app recovery. Keep at least two enrolled administrators, or store one administrator's recovery codes in the company's sealed break-glass storage.

## Same-origin cookies and CSRF

The browser calls only `/api/backend/...` on the Next.js origin. This narrow allowlisted proxy forwards to NestJS with a server-only shared secret and only the session cookie. It forwards NestJS `Set-Cookie` back to the browser without a Domain attribute. The cookie therefore belongs to the Vercel frontend, not the Render domain; third-party cookies are unnecessary. Server Components forward the same cookie directly to NestJS. No tokens are stored in localStorage or exposed through client environment variables.

Production cookie: `__Host-operations.sid`, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Local HTTP development uses `operations.sid` with Secure=false. Default absolute expiry is eight hours, configurable from one minute to 24 hours. Touch/rolling extensions are disabled. PostgreSQL prunes expired session rows periodically. Use HTTPS and `NODE_ENV=production` on both hosted applications. A local production frontend (`next start`) also requires production-compatible API cookie settings and HTTPS; use `npm run dev` for normal HTTP localhost testing.

All state-changing requests, including login/logout, require an Origin exactly matching one of the configured `WEB_ORIGIN` values, JSON content type, and `X-CSRF-Protection: 1`. The BFF also rejects a cross-site `Sec-Fetch-Site` value. Cross-origin HTML forms cannot satisfy this non-simple-header contract; cross-origin fetch preflights are not allowed by the BFF. NestJS independently enforces the Origin/header/JSON checks plus the server-only BFF key. The BFF never trusts a client-supplied BFF key, forwarding protocol, destination URL, or arbitrary API path. SameSite is additional protection, not the only CSRF defense. Tests cover login CSRF, authenticated mutations, logout CSRF, direct API bypass, and the BFF allowlist. CORS is not authorization and browser-to-Render credentialed CORS is not used.

Login uses atomic PostgreSQL counters shared by all API instances, keyed by SHA-256 digests (no emails or addresses are stored). The client IP is the `x-client-ip` value the BFF forwards from Vercel's `x-forwarded-for`; the API trusts it only on requests carrying the server-only BFF secret. Limits: 100 attempts per address per 15 minutes (never reset by a success, so an office sharing one address still has room); 10 attempts per email and address per 15 minutes; 20 failed attempts per email from any address per 15 minutes; and a 1000-per-minute service-wide circuit breaker that protects Argon2id CPU and memory. A correct password clears the email and email+address counters, so users do not lock themselves out and a targeted lockout requires a sustained stream of failures. Locked accounts are rejected before the password check with the same `429` for known and unknown emails; the dummy hash keeps timing identical. Expired counter rows are pruned during login. An edge/WAF limiter and monitoring remain advisable.

## Environment variables

The root `.env.example` is a reference only. NestJS loads `apps/api/.env`; Next.js loads `apps/web/.env.local`. Never commit secrets or use `NEXT_PUBLIC_` for these values.

| Variable | App | Meaning |
| --- | --- | --- |
| NODE_ENV | API | development/test/production |
| PORT | API | Default 4000; Render supplies its port |
| DATABASE_URL | API | Secret PostgreSQL URL |
| DATABASE_SSL | API | false only for localhost or a dotless private host (Render's internal `dpg-…-a` URL); production refuses false for any DNS name or IP address. true verifies TLS |
| CORS_ORIGINS | API | Comma-separated exact HTTP(S) origins, no trailing slash/wildcards (at most 10) |
| SESSION_SECRET | API | Required random secret of at least 32 characters; rotation invalidates cookies |
| BFF_SHARED_SECRET | Both servers | Required separate random secret, identical in Next.js and NestJS; at least 32 characters |
| WEB_ORIGIN | Both servers | Exact frontend origin, or a comma-separated list (at most 10) when the workspace is served from several domains, e.g. `https://workspace.ugemconsulting.com,https://your-workspace.vercel.app`. No paths or wildcards; all HTTPS in production. Any listed origin may send mutations; the first is the primary origin used in invitation links. Use the same list in both apps |
| SESSION_TTL_SECONDS | API | Absolute session lifetime, default 28800 |
| API_BASE_URL | Web server | Backend origin without `/api` |
| ALLOW_DEMO_SEED | Seed only | Explicit true required; never production |
| DEMO_ADMIN_EMAIL/PASSWORD | Seed only | Fictional admin credentials |
| DEMO_MANAGER_EMAIL/PASSWORD | Seed only | Fictional manager credentials |
| DEMO_IT_EMAIL/PASSWORD | Seed only | Fictional IT credentials |
| DEMO_SAFETY_MANAGER_EMAIL/PASSWORD, DEMO_SAFETY_LEAD_EMAIL/PASSWORD, DEMO_SAFETY_STAFF_EMAIL/PASSWORD | Seed only | Fictional Safety manager, Safety lead and safety staff credentials |
| TEST_DATABASE_URL | Integration tests only | Dedicated disposable database whose name ends in `_test` |
| EMAIL_DELIVERY | API | `none` (default; local CLI codes, production verification fails closed) or `smtp` (real applicant emails). See [email delivery](docs/email-delivery.md) |
| SMTP_HOST / SMTP_PORT | API | `smtp.gmail.com` / `465` for Google Workspace; `localhost` / `1025` for local Mailpit |
| SMTP_USER / SMTP_PASSWORD | API | Sending mailbox and its app password; secret, set only in the host's environment settings |
| EMAIL_FROM | API | Sender, e.g. `UGEM Operations <onboarding@ugemconsulting.com>` |
| STAFF_EMAIL_FROM | API | Sender of staff two-step verification codes, a different address the SMTP mailbox may send as (Gmail "Send mail as" alias), e.g. `UGEM Workspace <no-reply@ugemconsulting.com>`. Email codes are offered only when set |
| TELEGRAM_DELIVERY | API | `none` (default) or `bot`: applicant status updates through the company Telegram bot. See [applicant updates](docs/applicant-updates.md) |
| TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_USERNAME | API | Bot token from BotFather (secret, host settings only) and the bot username used in connect links |
| MFA_ENCRYPTION_KEY | API | 32 random bytes as base64; encrypts staff authenticator secrets. Required by the production API; `npm run setup:local` generates a local one. See [staff two-step verification](#staff-two-step-verification) |
| PII_ENCRYPTION_KEY | API | 32 random bytes as base64, different from the MFA key; encrypts driver SSNs. Without it drivers can't enter an SSN and staff can't view one (the API still starts). Keep a private backup: changing or losing it makes stored SSNs unreadable. `npm run setup:local` generates a local one |
| DEPLOYMENT_PURPOSE | API, web | API: `local` (development), `production` or `staging` (hosted; staging requires `NODE_ENV=production`); `demo` was retired and is refused. Web: set `staging` only on the staging deployment for its banner. See [staging](docs/staging.md) |

Use separate secrets/environments for previews and production. `validateEnvironment` refuses DATABASE_URL query parameters `ssl`, `sslmode`, `sslcert`, `sslkey`, `sslrootcert`, `sslpassword` and `sslaccept` in every environment, because pg would merge them over the explicit `DATABASE_SSL` certificate-verification policy; the bootstrap and demo-retirement CLIs share that check. Secrets and sensitive request/database error details are not logged.

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

The database suites apply migrations and truncate identity and dependent onboarding tables in the explicitly selected test database. It covers all roles (administrators through the authenticator step), invalid credentials, disabled/SSO-only users, session expiration and revocation, logout replay, login throttling, deny-by-default policies, privilege escalation, CSRF, user creation, case-insensitive duplicate email rejection, and idempotent demo seeding. Passwords and secrets for tests are generated at runtime. BFF CSRF and allowlist helpers are also unit-tested. `mfa.integration.spec.ts` covers forced administrator enrolment, sign-in with authenticator and recovery codes, wrong/replayed/expired codes, lockout, session revocation on enrol/disable/reset, the all-staff policy and the refused migration rollback; `mfa.spec.ts` unit-tests encryption, TOTP windows, recovery codes and key validation. Test databases must be managed independently from the app database.

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

Migration generation paths are relative to `apps/api`. The Render-specific start:render command runs pending migrations before starting the API. Builds and ordinary start/dev commands never migrate. For manual releases, run migration:run:prod explicitly. The identity rollback drops identity data and is intended for disposable verification databases or carefully reviewed recovery.

## Vercel and Render (manual deployment only)

No cloud resources or production accounts have been created. Deployment requires approval. The optional `render.yaml` blueprint can create billable resources.

1. Render API: keep root directory at repository root; Node 24; build `npm ci --include=dev && npm run build --workspace=@operations/api`; start `npm run start:render --workspace=@operations/api`. Use the internal PostgreSQL URL, explicit CORS origin, and `/api/health` as health check. The Render start command applies pending migrations automatically before the API starts.
2. Set API `NODE_ENV=production`, a strong `SESSION_SECRET`, a separate `BFF_SHARED_SECRET`, `WEB_ORIGIN=https://your-workspace.vercel.app`, and `SESSION_TTL_SECONDS`. Never put these secrets into tracked YAML. Swagger is mounted only outside production. Every API response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin` and a default `Cache-Control: no-store` that file routes may replace; `X-Powered-By` is disabled. Startup failures in `npm start` and `start:render` print only a sanitised reason (setting rule or error code) and exit 1; production Nest logs keep only the first line of string messages.
3. Vercel: root `apps/web`, Next.js preset, Node 24, enable inclusion of files outside the root for the workspace lockfile. `vercel.json` installs from the repository root and builds only web. Set server-only `API_BASE_URL=https://your-api.onrender.com`, matching `BFF_SHARED_SECRET`, and exact `WEB_ORIGIN=https://your-workspace.vercel.app`. To serve the workspace on a custom domain as well, list both origins (primary first) in `WEB_ORIGIN` on Vercel and Render, and in the API's `CORS_ORIGINS`, then redeploy both. Each domain keeps its own host-only session cookie, so users sign in separately on each.
4. Browser cookies remain on the Vercel domain; the BFF adds the trusted forwarding protocol after verifying browser origin. Do not enable direct cross-site session cookies or credentialed CORS. Use a dedicated preview API/environment with matching origin for preview deployments rather than wildcard origins.
5. Auto-deploy is off in the blueprint; disable Blueprint Auto Sync separately if manual configuration sync is required. Production account provisioning is deliberately outside this demo seed and requires an approved administrative process. Do not relax the seed's production guard.

Staging (deployed from `dev`) uses its own Render API service, database and Vercel deployment with `DEPLOYMENT_PURPOSE=staging`; see [staging](docs/staging.md).

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

The Onboarding dashboard now shows awaiting review (SUBMITTED + RESUBMITTED), changes requested, resubmitted, approved and rejected counts across the manager's entire scope. Application review supports name/email/MC/team-lead/reference search, status filters, sorting and 10/20/50-row pages. SYSTEM_ADMIN sees all records; managers only see their own assigned records. IT can access only approved onboarding profiles/checklists, not application drafts or review actions.

Open a submitted application's review page to view submitted information, decisions, reviewer identity, comments, old/new resubmission values and an activity timeline. Approval and rejection require explicit confirmation. Approval also requires confirmation of final MC, team lead and job title; the manager may correct those values in the approval dialog. Rejection and correction requests require a reason; corrections also require at least one flagged personal field. The correction dialog clearly identifies applicant-visible instructions; approval/rejection comments remain internal. Approved/rejected applications cannot be edited or reopened, including by administrators.

For a complete fictional demo:

1. Create an invitation and submit the application using the invitation walkthrough above.
2. As the manager, open **Applications → Review details → Request changes**. Supply an applicant-facing reason and flag fields such as phone or Telegram.
3. As the applicant, visit `/apply/draft` and select **Check status**, or visit `/apply/resume` and use a fresh verification code. A consumed invitation token is never reused for corrections.
4. Update only the highlighted fields. **Save corrections** retains CHANGES_REQUESTED; **Resubmit application** moves it to RESUBMITTED.
5. The manager sees the resubmission in the dashboard, compares previous/submitted values, and approves with confirmation. Approval atomically creates an internal IT request and seven checklist tasks (Equipment is optional); no external accounts are created.

Correction drafts remain private to the applicant until resubmission. First/last names, personal/work phone numbers, American names, Telegram, MC, team lead and job title can be flagged. Verified email cannot change. Applicant employment answers remain distinct from the manager-confirmed assignments recorded at approval. A correction request grants 30 days of application access independently of invitation-token expiry, without extending the one-hour applicant session. Reverification is still required after session expiry. Production email verification remains disabled.

The application status is the single source of truth. Review decisions record reviewer ID, prior/new status, reason, selected fields and a timestamp. Submitted revisions preserve comparison data separately from metadata-only audit events. Review/submission events are durable and notification-ready; the dashboard and applicant status page are the MVP notifications. No email, Telegram message or external notification is sent.

## Review migration and repeatable verification

`1792620000000-ApplicationReview.ts` extends review statuses and records history. `1792630000000-OptionalInvitationDetails.ts` makes invitation details optional, separates expected/verified email, binds challenges to an email, preserves legacy employment details in working/submitted fields, and adds employment confirmation history. Existing records and approval states are preserved. Schema synchronization and TypeORM migrationsRun remain disabled. The Render start:render wrapper applies pending migrations; local development uses explicit `npm run migration:run`. This local development database was migrated during implementation; no production database was changed.

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

Verification covers 88 tests, including all existing authentication/invitation regressions and the full submitted → changes requested → correction draft → resubmitted → approved integration flow. It also covers rejection privacy, required reasons/confirmations, immutable terminal states, cross-manager and IT denial, stale/concurrent decisions, field restrictions, fresh verification after invitation expiry, queue pagination/search and review throttling, concurrent invitation claiming, optional expected-email restrictions and confirmed employment assignments. Type checks, warning-free lint, frontend/backend production builds and the default non-database test run all passed.

A real Next.js BFF HTTP smoke test passed the complete invitation-to-approval workflow, including fresh returning verification, manager/applicant views, submitted comparisons, private correction drafts, query forwarding, terminal state and health. The browser tool still could not initialize, so responsive visual checks, keyboard dialog interactions and full browser form behavior require manual QA. HTTP tests do not replace these checks.

No dependencies were added or upgraded for invitation simplification. The previous full audit reported 26 unresolved findings (21 moderate, five high) in existing transitive tooling chains and Swagger's YAML chain; no forced audit fixes were applied. Before real deployment, address the documented dependency advisories, approved email delivery, invitation URL redaction, retention of submission revisions/comments, edge rate limits and scheduled cleanup. No cloud resources or external messages were created.

## Optional invitation details and compatibility

A new invitation is unclaimed: expectedEmail optionally restricts who can claim it, while email is set only after a successful verification. Challenge creation does not reserve the invitation. Verification rechecks the invitation under a row lock and atomically binds the first verified identity; losing claimants receive a generic verification error. Token hashes, expiry, revocation, manager ownership, unique application creation, CSRF and database-backed restricted sessions remain in place.

Legacy invitation email restrictions, employment details, drafts, submissions, reviews, approvals and pending verification challenges are preserved by the additive migration. Deprecated employment fields on the creation API are accepted as optional prefills for older clients; the manager UI no longer asks for them. New approvals require `employmentConfirmed: true` and an `employment` object containing MC, team lead and job title. This intentional API validation change prevents an approval from skipping assignment confirmation. Previous approvals are not reopened or invalidated.

The approval transaction writes final assignments to the existing invitation columns used by the IT-ready record contract and records previous/final assignments in review history. Applicant-submitted values stay intact for comparison. The existing APPROVED/readyForIt contract is preserved. New approvals now create linked manual IT onboarding requests; historical approvals are not automatically backfilled.

After a production build, verify migration compatibility only on a dedicated local disposable database:

```sh
ALLOW_DISPOSABLE_DB_RESET=true TEST_DATABASE_URL="postgresql://operations:operations@localhost:5432/operations_m2_test" node scripts/invitation-migration-check.cjs
```

This verifies preservation of legacy identities, drafts/submissions, reviews, approved states and challenges; rollback/reapplication; and refusal to discard new simplified invitation data. The existing review migration script was updated to account for the new migration. The HTTP smoke script now creates an invitation with no details, claims it, completes employment, saves/resumes, resubmits corrections and approves with confirmed assignments. Production verification still fails closed until approved delivery is implemented; no development-only verification code is exposed in production.

## Local verification troubleshooting

Use an `@example.test` fictional personal email in the applicant page. If the manager set an expected email, it must match. Other domains are rejected with a clear local-demo explanation. A generic verification reference does not by itself guarantee that the invitation matched; unknown/mismatched addresses and unavailable links never reveal applicant details.

The terminal command reports when a reference is missing, expired, already used, or has no available invitation. Click **Start again** for a fresh reference, or use `/apply/resume` with the verified email/application reference after the invitation has been consumed. For database/configuration errors, check `apps/api/.env`, PostgreSQL and migrations. Raw connection errors and secrets are never printed. Production verification remains disabled.

## Required dispatcher contact and American names

The application now requires `firstName`, `lastName`, `personalPhoneNumber`, `preferredAmericanFirstName`, and `preferredAmericanLastName`, in addition to the existing employment requirements. Labels are **First Name**, **Last Name**, **American First Name**, and **American Last Name**. American names are trimmed and whitespace-only values are rejected at submission and approval. Incomplete drafts may still be saved.

Personal phone is required; work phone is optional and normally assigned later by IT. Existing values remain separate. International formatting is accepted: optional leading `+`, spaces, parentheses, dots and hyphens, with 7–15 digits and at most 40 total characters. Frontend Zod, NestJS DTO validation and merged-field validation enforce the same structural contract; this does not verify carrier ownership or infer a country. No personal phone is copied into the work-phone field.

`1792640000000-ApplicantRequiredDetails.ts` maps existing JSONB `phone`, `preferredFirstName` and `preferredLastName` values to the canonical field names in application drafts and submitted revisions, preserving the original values/keys. It also maps historical correction field identifiers. It never invents work numbers or names, changes statuses, or invalidates historical approvals. The TypeORM entity's existing JSONB field contract is extended rather than introducing conflicting copies in separate columns.

Existing records missing required details remain viewable. New submission/resubmission or approval requires completion. Managers can request corrections to the new fields; required missing/invalid fields are included automatically. Existing correction rounds also allow completing newly required fields from the last submitted revision, and those fields remain editable while corrections are saved. Saved correction answers remain private until resubmission. Existing APPROVED applications remain approved even if they lack newly required data; their details show missing information without reopening them.

Manager review, applicant review summaries and correction forms show both phones and both American names. The authorized review response includes `itDetails`, with the legal first/last names retained separately and an American-name-based `proposedDisplayName`. No display name is proposed when either American name is missing; legal names are not substituted or overwritten. The IT onboarding profile uses this projection with manager-approved assignments; no external accounts are provisioned.

After building, verify this migration only on a disposable LOCAL test database:

```sh
ALLOW_DISPOSABLE_DB_RESET=true TEST_DATABASE_URL="postgresql://operations:operations@localhost:5432/operations_m2_test" node scripts/application-details-migration-check.cjs
```

Rollback restores legacy field identifiers and keeps canonical JSON values, including collected work numbers, so data is not discarded. Reapplication is safe. Existing review/invitation migration checks were updated for the additional migration. Verification includes frontend/backend validation, missing/blank values, international/invalid phones, separate phone preservation, corrections to required fields, legacy approval access, migration rollback/reapply, and the full Next.js HTTP workflow. Browser visual/keyboard QA remains manual when browser automation is unavailable. No dependencies were added, external services configured, or cloud deployments performed.

## Milestone 5 — Manual IT onboarding

Run `npm run migration:run` before starting the updated API. `1792650000000-ItOnboarding.ts` adds requests, checklist tasks, metadata-only activity and recipient-scoped portal notifications. The local development database was migrated during implementation. Existing approved applications remain approved; the migration does not queue old approvals or invent missing staff data. New manager/admin approvals create one IT request and seven tasks atomically; duplicate approval retries cannot create duplicate requests.

1. Complete and approve a fictional application using the existing walkthrough.
2. Sign in as `it@example.test` using the private generated password in `apps/api/.env`. Open **IT tasks**, then the approved American display name.
3. Review the approved profile, including separate American/legal names, personal/work phone numbers and the manager-confirmed MC, team lead and job title. Internal review comments and unapproved applicant data are not included.
4. New applicants are not asked for a work phone. In the **RingCentral** section, IT records the **Actual Assigned RingCentral Phone Number**. Existing applicant-provided work phones are preserved and labeled **Applicant Provided** until IT verifies them; the assigned number remains separate.
5. RingCentral number setup, SMS and call recording appear together in one RingCentral section with individual task statuses. Update Google Workspace, Dispatch group membership, those RingCentral tasks and approved business software tasks to Pending, In Progress, Blocked or Completed. Blocked requires a reason. Record fictional manual setup notes only; never enter passwords or tokens.
6. RingCentral completion requires its actual assigned number. Finishing the last task requires verification only when a legacy applicant work phone exists; an absent work phone does not block completion. Completing every task (or marking the optional Equipment task Not needed) closes the request and create one notification for the responsible manager in the same transaction.
7. As the manager, refresh **Dispatcher onboarding** to see the completion update, open the application to see IT progress, and mark the notice as read.

The application remains APPROVED as the review result; IT progress is separate and derived from task states/completion timestamp. Pending/active requests can be updated with version checks; completed requests are immutable. No Google Workspace/RingCentral account, SMS, recording or software installation is performed by these controls. This is a manual fictional demonstration, not an external integration.

IT/admin can search and filter the approved queue with server-side pagination (20 rows/page, API maximum 50). Managers cannot operate IT tasks and receive only their own application progress and portal notifications. Notification lists show the latest 50 notices with unread counts; updates appear on refresh, without realtime push or email delivery. Approved business-software selection/authorization is a manual company process recorded in task notes; there is no software catalog/integration yet.

After `npm run build`, repeat the local HTTP and migration checks:

```sh
ALLOW_LOCAL_REVIEW_SMOKE=true node scripts/review-smoke.cjs
# Destructive: LOCAL disposable *_test database only.
ALLOW_DISPOSABLE_DB_RESET=true TEST_DATABASE_URL="postgresql://operations:operations@localhost:5432/operations_m2_test" node scripts/it-migration-check.cjs
```

The HTTP smoke test now covers invitation → verification → draft/submission/corrections → approval → IT profile → separate phone verification/assignment → checklist completion → manager portal notification/read acknowledgement. It deliberately leaves a fictional completed onboarding record. Migration checks verify up/down/reapplication, existing approval preservation, uniqueness and refusal to discard IT workflow data. Earlier review/invitation/required-detail migration scripts were updated and checked against the new migration stack.

88 tests pass, including rollback of an approval when checklist creation fails, role/CSRF/session restrictions, malformed input, conflicting IT edits, phone separation, completion requirements, duplicate final updates and notification ownership. Type checks, lint and independent production builds pass. Interactive browser visual/dialog/keyboard QA remains manual.

## Vercel/Render demo readiness

Both applications build independently and retain the existing Vercel/Render configuration. No additional environment variables or external credentials are required for manual IT onboarding. The Render-specific startup step applies pending migrations before starting the API; keep matching BFF secrets/origin, HTTPS production cookies, PostgreSQL and Node 24 configured as documented above. No resources were created or deployed.

The staff approval/IT demo is ready for hosting after environment setup and approved demo-account/data provisioning. The local seed intentionally refuses production and must not be weakened. End-to-end applicant verification on hosted production domains still needs an approved production email-delivery mechanism; the development CLI is deliberately disabled there. A complete hosted applicant-to-IT demo is therefore blocked on that setup. Retention/backups, edge rate limits, manual browser QA and previously documented dependency advisories remain production-readiness work. See [IT architecture](docs/it-onboarding.md).

## First real administrator bootstrap

`seed:demo` remains fictional-only and refuses production. Use the separate **manual** `admin:bootstrap` command for a first real administrator. It creates one ACTIVE SYSTEM_ADMIN with the existing Argon2id password helper. It refuses if **any** SYSTEM_ADMIN exists (even inactive), or if the normalized email belongs to any existing user. It never overwrites, promotes, reactivates or resets an account. After bootstrap, use the authenticated Staff accounts page for further staff management. Bootstrap is not account recovery.

Build the API using Node 24 and apply reviewed migrations explicitly before bootstrap. No new migration is needed. Administrator bootstrap never runs during startup or normal builds. The command requires an interactive terminal and asks for the password twice with echo suppressed (12–128 characters, no control characters). Use a unique password from your password manager. Do not pass a password as an argument, environment variable, pipe, shell command, or job command; do not record the terminal session. Exit status is nonzero on failure. Success prints only a generic confirmation.

Required configuration uses the existing validated API environment: `NODE_ENV`, `DATABASE_URL`, `DATABASE_SSL`, `WEB_ORIGIN`, `CORS_ORIGINS`, `SESSION_SECRET`, `BFF_SHARED_SECRET` (different secrets, each at least 32 characters). Production requires an HTTPS WEB_ORIGIN. Also set:

```dotenv
BOOTSTRAP_ADMIN_EMAIL=administrator@example.test
BOOTSTRAP_ADMIN_FIRST_NAME=Avery
BOOTSTRAP_ADMIN_LAST_NAME=Example
```

Those are fictional illustrations; the authorized operator supplies the real identity privately. No default password exists. Names are trimmed (1–100 characters); email is trimmed, lowercased and validated (maximum 254 characters).

### Render paid shell: explicit one-time execution

[Render supports interactive shells on paid services](https://render.com/docs/ssh). Open the API service's Dashboard **Shell**, or an authorized SSH session, after deploying the build containing this command. From the repository root, use the existing API environment and set the three BOOTSTRAP_ADMIN_* identity values. For this CLI, select the database's **external hostname URL** and set `DATABASE_SSL=true`; internal Render certificates are self-signed, so the CLI's verified-TLS policy uses the external connection. Ensure the database allowlist admits the executing service's outbound address. Supply database configuration privately through Render's environment controls or a hidden shell input, never by pasting a credential-bearing export into shell history. Do not change the service's normal start/build command.

```sh
npm run admin:bootstrap
# Equivalent when already in apps/api:
npm run admin:bootstrap --workspace=@operations/api
# Direct compiled entry point from the repository root:
node apps/api/dist/database/admin-bootstrap.js
```

Use **one** of these commands once, then enter and confirm the initial password at the hidden prompt. This is an interactive shell operation, not a background one-off job: unattended jobs cannot answer the prompt. Remove temporary BOOTSTRAP_ADMIN_* environment entries afterward. Keep database credentials and server secrets private. Log in through the existing frontend; all normal session, CSRF, status and permission protections apply.

### Render Free: locally executed one-time CLI

[Free services do not provide shell access or one-off jobs](https://render.com/docs/free). On a trusted local computer, check out the same release and use Node 24. Temporarily allow only that computer's public IP in the database external-access allowlist; restore the previous restrictions afterward. [Render's external database connection uses TLS](https://render.com/docs/postgresql-creating-connecting). Use the **external** URL with its full DNS hostname, port and database name. Remove URL SSL query parameters (`sslmode`, `ssl`, `sslcert`, `sslkey`, `sslrootcert`); this command requires `DATABASE_SSL=true`, which uses `rejectUnauthorized: true`. Never disable certificate verification or use an IP in place of the hostname.

From the repository root:

```sh
npm ci
npm run build --workspace=@operations/api
# Create a private Git-ignored configuration file before editing it.
touch .env.admin-bootstrap
chmod 600 .env.admin-bootstrap
```

Edit `.env.admin-bootstrap` privately with the required API configuration and three identity variables listed above. Set `NODE_ENV=production`, the target external `DATABASE_URL`, `DATABASE_SSL=true`, the deployed HTTPS origin, and the API's required secrets. **Do not put the administrator password in this file.** Confirm the target database privately; this command does not migrate it automatically. If migrations are not applied, the authorized release operator must apply them separately using the existing migration command/configuration.

```sh
# From repository root; dotenv reads this file from the API workspace directory.
DOTENV_CONFIG_PATH=../../.env.admin-bootstrap npm run admin:bootstrap
```

Inherited environment values override dotenv files: start from a clean terminal and remove conflicting exported API variables before running. The private file must contain all required API values so the local development `.env` is not used. Enter and confirm the password interactively. Remove the temporary file after use, clear temporary environment values, and restore external access restrictions. Do not enable HTTP bootstrap, change startup scripts, or weaken `seed:demo` for Free hosting.

The bootstrap transaction takes the existing administrator advisory lock and a PostgreSQL SHARE ROW EXCLUSIVE lock on users. This serializes concurrent bootstrap attempts and all user writes while checking for administrators/duplicate email and inserting; one concurrent invocation succeeds and others refuse. Failed operations roll back. Hashing happens before the lock. Normal database timeouts bound lock waits; reruns refuse once an administrator exists. No connection strings, raw database errors, passwords, hashes or session secrets are printed. JavaScript cannot guarantee memory zeroization; run on a trusted host and exit afterward.

Bootstrap tests use random passwords and fictional identities in the dedicated disposable `TEST_DATABASE_URL` ending in `_test`; never point them at a real environment. Run the default suite plus the existing opt-in PostgreSQL suite, type checks, lint and builds. The production bootstrap was not executed during implementation.

Bootstrap verification: all 109 tests passed with the opt-in local PostgreSQL suite, along with type checks, lint and both production builds. Pseudo-terminal checks confirmed hidden entry, mismatch rejection, Ctrl+C cancellation and EOF cancellation without echoing passwords. Only fictional test accounts in the disposable database were created; no real account, production connection or deployment was performed. Existing dependency advisories described above remain unchanged; no packages were added or upgraded.

## Automatic migrations on Render Free

In Render API service **Settings → Build & Deploy**, use repository root, build `npm ci --include=dev && npm run build --workspace=@operations/api`, and **Start Command** `npm run start:render --workspace=@operations/api`. This works without a paid pre-deploy hook. The optional render.yaml blueprint now uses that start command too; a manually configured service must be updated in the dashboard. No Render settings or deployments are changed automatically by editing this repository.

Each start (deploy, restart or cold start) checks the compiled TypeORM migration history, applies only new migrations, then starts NestJS in the same process. Applied migrations are skipped. A PostgreSQL session advisory lock serializes overlapping migration runners before history-table initialization/checks. The lock and all migration queries share one connection so connection loss cannot leave migrations running without the lock. An explicit silent TypeORM logger prevents raw migration error messages from leaking data. All pending migrations run in one transaction; failure prevents API startup, exits nonzero and suppresses sensitive error details. The migration-only pool allows a 60-second statement/lock timeout; the API's existing timeout remains unchanged. Use the same locked runner for manual production migrations with `npm run migration:run:prod --workspace=@operations/api`; do not run competing source-based CLI migration commands against a deploying database.

Keep the existing validated API environment configured on Render: NODE_ENV=production, Node 24, DATABASE_URL, DATABASE_SSL, WEB_ORIGIN, CORS_ORIGINS, distinct SESSION_SECRET/BFF_SHARED_SECRET and SESSION_TTL_SECONDS. Use the same-region internal database URL with DATABASE_SSL=false as in the blueprint, or an external hostname URL with DATABASE_SSL=true and certificate verification. No new secret or flag is needed. Keep synchronize=false and migrationsRun=false: the explicit Render startup wrapper is the only automatic migration entry point. Ordinary npm start/dev, builds, demo seed and administrator bootstrap are unchanged. Administrator bootstrap never runs automatically.

Review every migration before shipping it. Because the previous API instance can still run while a new one starts, migrations must remain compatible with the previous version (add first, remove in a later release). Keep backups for real data; failed application deployment does not automatically undo already committed migrations. Never use startup rollbacks or schema synchronization. Long migrations exceeding the timeout require a separately planned release operation.

## Login 503 and Render Free startup delays

A 503 from `/api/backend/auth/login` can mean missing/invalid frontend environment configuration or failure/timeout reaching NestJS. The proxy now waits up to 90 seconds for the backend and exports maxDuration=120. Enable Vercel **Fluid Compute** for this duration (its Hobby limit supports 120 seconds); redeploy the frontend after changing environment values or code. Render Free can sleep after inactivity and take about a minute to wake: https://render.com/docs/free. Vercel duration configuration: https://vercel.com/docs/functions/configuring-functions/duration. A longer deadline accommodates a cold start but cannot repair a crashed service or incorrect URL. No state-changing request is automatically retried.

Check the public Render `/api/health` endpoint first. In Vercel Production environment, API_BASE_URL is the backend HTTPS origin without `/api`; WEB_ORIGIN is the frontend HTTPS origin; BFF_SHARED_SECRET must match Render. The proxy validates these variables (including header-safe secret formatting) and logs only allowlisted diagnostic codes in **Vercel Runtime Logs**: API_BASE_URL_MISSING/INVALID, WEB_ORIGIN_MISSING/INVALID, BFF_SHARED_SECRET_MISSING/INVALID, BACKEND_TIMEOUT, ENOTFOUND, ECONNREFUSED, selected TLS/network codes or BACKEND_REQUEST_FAILED. Never log raw exceptions, URLs with credentials, request bodies, cookies, hashes or secret values. Timeout responses ask users to wait and retry; inspect Render logs if health still fails. A warm backend with auth/me returning 401 is the expected unauthenticated result, while 403 may indicate boundary-secret mismatch. Existing CSRF/origin checks and endpoint allowlisting remain enforced. Server-rendered authenticated page requests retain their separate shorter deadline; after a cold-refresh error, retry once the backend is awake.

## Production readiness: email delivery and the retired demo

Applicant verification codes are emailed through Google Workspace SMTP; see [email delivery](docs/email-delivery.md). Invitation links have the form `https://<frontend>/apply#<token>`: the token sits in the URL fragment, which browsers never send to servers, so it cannot appear in Vercel, Render or APM request logs. The older `/apply/<token>` path form has been removed.

The fictional hosted demo (demo mailbox, starter conversion, `DEMO_*` settings and banner) has been removed. The API refuses `DEPLOYMENT_PURPOSE=demo` and any leftover demo setting, and migration `RetireDemoDeployment1792690000000` refuses to run on the database that was bound to the demo, so production code cannot start against it. Go live on a **fresh production database**: run migrations, create the first administrator with `admin:bootstrap`, then set the email settings. `seed:demo` and `verification:demo` remain local development tools for fictional data only.

### Cleaning up a database that was converted to the demo

If a deploy logs `migration refused: This database belongs to the retired fictional demo deployment`, that database was converted with the former `demo:convert-starter`. Instead of replacing it, run the one-time `demo:retire-database` command. In one transaction it deletes every fictional demo record and fictional staff account, keeps the preserved administrator (who signs in again), and removes the demo marking. It refuses unless the database is marked as the demo, the operator is still an active administrator, and every other account is `@example.test`. It prints counts only.

1. Take a manual backup of the database in Render.
2. On a trusted computer with this release built (`npm ci` and `npm run build --workspace=@operations/api`), allow your IP in the database's external access settings. Create a private, Git-ignored file such as `.env.retire-demo` containing only `DATABASE_URL=<external URL>` and `DATABASE_SSL=true`.
3. Dry run (changes nothing): `DOTENV_CONFIG_PATH=../../.env.retire-demo npm run demo:retire-database`
4. Apply, then type the database name when asked: `DOTENV_CONFIG_PATH=../../.env.retire-demo npm run demo:retire-database -- --apply`
5. Redeploy the API. `start:render` applies `RetireDemoDeployment`, which drops the remaining demo tables. Remove your IP from the allowlist and delete the private file.

In PowerShell, set the path first: `$env:DOTENV_CONFIG_PATH='../../.env.retire-demo'`, then run the npm command.

Applicant form validation returns to the affected step and displays a message for both draft-save and submit failures, including invalid phone numbers entered on earlier steps. Review submission still requires all required fields and accuracy confirmation; invalid input is never silently submitted.

Applicant work phone is optional for submission, resubmission and manager approval. New forms collect the required personal phone and leave work-number assignment to IT during RingCentral setup. Saved work phones and explicitly requested corrections remain accessible and validated. RingCentral, SMS and call recording share one IT section while retaining independent checklist states and history. Apply the additive OptionalApplicantWorkPhone migration: it relaxes the IT completion constraint for absent applicant work phones without changing records or task history. Rollback refuses if completed requests now depend on this allowance.
