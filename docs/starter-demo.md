# Convert the existing starter to a temporary demo

The owner confirmed this hosted app is only a starter with one SYSTEM_ADMIN and authorized reusing it for a temporary demonstration. This guide is the supported setup path; no separate demo services are required. Do not use starter conversion on an established production system or on real employee/applicant data. There is no automatic cleanup, account reset, cloud deployment or HTTP conversion endpoint.

## Eligibility and preservation

The manual `demo:convert-starter` command requires all normal demo flags plus `DEMO_STARTER_MODE=true`. It permits the current database name and frontend hostname; the database identity must be converted explicitly before the simulator can run. It refuses unless there is exactly one user, an ACTIVE SYSTEM_ADMIN. That existing operator may keep their current email and password. New staff and all applicants must use @example.test.

Empty unclaimed invitations may remain only when their applications are still INVITED at version zero, contain no applicant fields, and retain only default/empty employment placeholders. Creation/revocation metadata is preserved. Claimed invitations, drafts, personal answers, submitted applications, verification challenges, applicant sessions, review history, IT requests and notifications refuse conversion. Nothing is deleted to force eligibility. Extra users also refuse conversion. If it refuses, investigate instead of truncating records or bypassing the checks.

Conversion serializes user/workflow writes in a transaction, records the operator UUID, deployment UUID, exact frontend origin and timestamp, and writes a STARTER_DEMO_CONVERTED event without personal data. The operator's ID, name, email, role and password hash remain unchanged. authVersion increases and staff sessions are cleared so the operator must sign in again. Repeating the same conversion is idempotent; another UUID/origin cannot take over. Changing NODE_ENV or enabling an environment flag alone does not convert a database.

Runtime checks permit the one bound active operator email exception; every other staff/applicant identity remains fictional. The operator cannot be disabled/demoted during demo use or change to a different real email. Database triggers enforce the exception too, including during login lastLoginAt updates. Mailbox authorization (administrators see all demo messages; managers see only their own invitations), encrypted storage, code hashing/expiry, attempt limits, CSRF, one-time invitation claims and applicant sessions remain unchanged.

## Short setup for the current starter

1. Build the release containing both simulator migrations and starter conversion: `npm run build`. Commit/push and deploy only when separately authorized. The current deployed application can remain in ordinary production-purpose mode while migrations/conversion are prepared.
2. Use the private Git-ignored root `.env.starter-demo` prepared locally. It contains the existing external PostgreSQL URL with DATABASE_SSL=true, frontend origin, session/BFF secrets, a new demo UUID and independent mailbox key. It contains no administrator password. Keep mode 600 and never upload/paste this file into chat. Clear conflicting exported environment values, because dotenv does not override them.
3. From the repository root, the shortcut applies reviewed migrations and then performs the guarded conversion:

   ```sh
   DOTENV_CONFIG_PATH=../../.env.starter-demo npm run demo:setup-starter
   ```

   It stops on failure. This command is manual only; it never runs in builds/startup. For separate diagnostic steps instead, apply the reviewed additive migrations against the intended starter database:

   ```sh
   DOTENV_CONFIG_PATH=../../.env.starter-demo npm run migration:run:prod --workspace=@operations/api
   ```

4. Explicitly convert it:

   ```sh
   DOTENV_CONFIG_PATH=../../.env.starter-demo npm run demo:convert-starter
   ```

   Expected: `Starter converted to demo. Existing administrator preserved; sessions revoked. No onboarding data deleted.` If eligibility fails, the transaction rolls back. Do not run admin:bootstrap or seed:demo: the existing administrator is retained.
5. On the existing Render API, retain the current database connection, frontend origin and session/BFF secrets. Add these values from the private file:

   ```dotenv
   NODE_ENV=production
   DEPLOYMENT_PURPOSE=demo
   DEMO_EMAIL_MODE=true
   DEMO_STARTER_MODE=true
   DEMO_FICTIONAL_DATA_ONLY=true
   DEMO_DEPLOYMENT_ID=<same UUID from .env.starter-demo>
   DEMO_MAILBOX_KEY=<same key from .env.starter-demo>
   ```

   Keep the existing start command `npm run start:render --workspace=@operations/api`. The internal Render database URL can stay internal with DATABASE_SSL=false; the local file uses the external TLS connection. Changing purpose before conversion intentionally prevents startup, so follow this order.
6. On the existing Vercel frontend, keep API_BASE_URL, WEB_ORIGIN and BFF_SHARED_SECRET unchanged. Set `DEPLOYMENT_PURPOSE=demo` in the project's Production environment. Deploy the simulator frontend and redeploy after changing environment values. Confirm **Demo Environment — Fictional Data Only** on login, applicant and staff pages.
7. Sign in using the existing administrator credentials. Administrators open Settings → Demo mailbox to reveal fictional applicant verification codes. Dispatcher Managers use Invitations → Open demo verification codes for their own invitations; no terminal or administrator handoff is required for their demonstration. The pending empty invitation can still be used. Create fictional manager/IT accounts in Settings if needed; use @example.test. The rest of the application/review/IT workflow is unchanged.

No separate Vercel project, Render service, domain or database is required for this expressly designated starter demo. The database is now a demo database, not a place to start collecting real employee data. Production-purpose configurations still refuse simulated verification.

## After the demo

No reset or cleanup is implemented or executed automatically. When the owner explicitly requests the production transition, provision/initialize a fresh production database, bootstrap its real administrator with the existing secure command, set DEPLOYMENT_PURPOSE=production and DEMO_EMAIL_MODE=false, DEMO_STARTER_MODE=false, DEMO_FICTIONAL_DATA_ONLY=false, and remove demo UUID/key settings. Configure real email verification delivery before accepting real applicants. Review backups/retention before disposing of the old demo database. Do not merely toggle the flag and reuse demo records as real employee records, delete the current administrator, or remove the marker/rollback guards.

## Repeatable local verification

The regression suite uses only local disposable databases (TEST_DATABASE_URL ending in _test and DEMO_TEST_DATABASE_URL ending in _demo_test). Starter tests cover operator/password preservation, session revocation, idempotence/concurrent conversion, refusal on extra staff/answers, pending-link preservation, the narrowly bound email exception and administrator/owner-scoped manager mailbox access. Test fixtures explicitly reset only those local databases, not the hosted starter.

After building, repeat the converted-starter HTTP check with:

```sh
ALLOW_DISPOSABLE_DB_RESET=true DEMO_SMOKE_STARTER=true \
DEMO_TEST_DATABASE_URL=postgresql://operations:operations@localhost:5432/operations_email_demo_test \
node scripts/demo-email-smoke.cjs
```

It checks production-runtime secure cookies, the existing-hostname configuration, preserved operator login, fictional applicants, banner, mailbox restrictions and draft/submission through Next.js and NestJS. It starts/stops only its own local servers and uses temporary trusted TLS certificates. No hosted settings or records are changed. Visual/keyboard browser QA remains manual.

Verification passed: 167 automated tests, type checks, lint, frontend/backend production builds, isolated and starter production-runtime HTTP smoke tests, and all four existing migration rollback/reapplication checks. A read-only hosted preflight found one active administrator, one safe empty invitation, no started applications/challenges/IT requests. No hosted migration, conversion, deployment or cleanup was performed during implementation.
