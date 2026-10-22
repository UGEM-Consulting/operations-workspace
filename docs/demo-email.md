# Fictional email simulator: security and verification

For deployment configuration and exact commands, use [the starter setup guide](starter-demo.md). That is the single supported operator setup: reuse the current eligible starter and existing services. No additional Vercel project, Render service, database or administrator bootstrap is needed. The former separate-server setup command has been removed.

## Security boundary

Hosted services keep NODE_ENV=production for Secure/HttpOnly cookies. Simulation requires DEPLOYMENT_PURPOSE=demo, DEMO_EMAIL_MODE=true, DEMO_STARTER_MODE=true, DEMO_FICTIONAL_DATA_ONLY=true, a UUIDv4 DEMO_DEPLOYMENT_ID and an independent base64-encoded 32-byte DEMO_MAILBOX_KEY. Environment flags alone cannot convert a database: the explicit starter converter checks eligibility and binds the database identity, deployment UUID, frontend origin and preserved administrator. Startup and delivery/mailbox access recheck this binding and fictional email records. Database triggers independently enforce fictional emails, with a narrow exception for the preserved administrator's unchanged email.

DEMO_FICTIONAL_DATA_ONLY is an operator attestation. Software cannot prove that a typed name or phone number is fictional. Use invented names, reserved @example.test addresses and fictional phone numbers; never import real employees or applicants. Only the already-existing operator may retain their real email. All new staff/applicant identities must be fictional.

The global banner is presentation only; NestJS enforces mailbox authorization. No codes are returned in public/applicant responses or logs. Authorized staff who explicitly reveal a code can necessarily inspect it in their own browser. Keep mailbox/session/BFF secrets private and distinct. Local CLI connections to hosted PostgreSQL require certificate-verified TLS; do not change hosted internal connection settings to match the external CLI URL.

## Production configuration

For a fresh real production deployment:

```dotenv
NODE_ENV=production
DEPLOYMENT_PURPOSE=production
DEMO_EMAIL_MODE=false
DEMO_STARTER_MODE=false
DEMO_FICTIONAL_DATA_ONLY=false
```

Leave DEMO_DEPLOYMENT_ID and DEMO_MAILBOX_KEY absent/empty. Production-purpose mode rejects simulation. Applicant verification remains unavailable until a real delivery provider is implemented; staff login remains available. seed:demo still refuses NODE_ENV=production. Do not toggle the converted demo database back into a real employee database: follow the fresh-database transition in the starter guide.

## Compatibility

Keep both additive migrations and the database identity/mode guards. The older isolated-mode helper remains covered by regression tests and must not become a path around starter eligibility. It has no operator CLI. Migration rollback refuses to discard an active demo identity, conversion audit or mailbox. Cleanup of setup instructions must not drop tables, delete records, remove security checks or reset the preserved administrator.

## Demonstration walkthrough

1. Manager signs in on the demo frontend and creates an invitation. Copy its unique link; optional expected email must be fictional. Use an incognito/second browser for the applicant and keep administrator sessions separate.
2. Applicant enters applicant@example.test (or the exact expected email), then selects **Verify access**. They receive only an opaque verification reference and generic instructions; no code, email details, hash or ciphertext is returned publicly. Invalid/unavailable invitation details have the same response shape and no delivered mailbox message.
3. The inviting Dispatcher Manager opens **Invitations → Open demo verification codes**, refreshes and matches that reference. Managers see only their own invitations; a SYSTEM_ADMIN can still access all messages through **Settings → Demo mailbox**. The list contains fictional metadata only. **Reveal verification code** requires an active authorized staff session, CSRF protection and the bound starter demo identity. NestJS filters lists by persisted invitation owner and rechecks ownership under lock before decrypting; guessed message IDs from another manager return 404. Each successful reveal is rate limited and audited without code values.
4. The manager or administrator privately shares the eight-digit code with the fictional applicant during the demonstration. The interface hides it after 30 seconds or tab hiding. Authorized staff-visible data is inherently inspectable by that staff member's browser; the prohibition is enforced for public/applicant responses and logs, not by claiming browser-visible secrets can be hidden from developer tools. Do not share screen recordings/devtools or put codes into chat/logging systems.
5. Applicant enters the code within ten minutes. Successful verification atomically consumes the challenge, binds the first applicant identity to the invitation, removes the mailbox message and establishes the existing restricted one-hour applicant session. Expired/consumed/revoked messages cannot be revealed or verified. No invitation token is reused.
6. Complete fictional personal/employment details, save drafts and submit. The manager can request corrections. A returning applicant uses their bound fictional email/application reference and a **new** verification challenge; the inviting manager or administrator retrieves the new simulated message. Complete corrections and resubmit, then approve with confirmed assignments. The existing manual IT request/checklist and manager notifications continue unchanged.

Codes use existing SHA-256 verification hashes, ten-minute challenge expiration, eight random decimal digits, one-time consumption and existing attempt/email/global rate limits. The mailbox stores only AES-256-GCM ciphertext with per-message random nonces and challenge-bound authenticated data; plaintext exists transiently during generation and authorized reveal. Losing/rotating the mailbox key invalidates pending reveals; issue new challenges rather than exposing old keys. Consumed messages are deleted transactionally; expired messages are inaccessible and deleted with expired challenge cleanup on subsequent begin calls. No external delivery occurs. Local verification:demo is disabled on designated demo databases so it cannot rotate mailbox codes.

## Verification and rollback

Default tests skip database integrations. Use two separate **local disposable** test databases:

```sh
TEST_DATABASE_URL=postgresql://operations:operations@localhost:5432/operations_m2_test \
DEMO_TEST_DATABASE_URL=postgresql://operations:operations@localhost:5432/operations_email_demo_test npm test
```

The demo test database must end in _demo_test and be local. Test setup resets its identity/data intentionally and never accepts a hosted URL. Tests cover isolated delivery, encryption, public response privacy, owner-scoped manager reveal, administrator access, cross-manager denial and CSRF, real-address rejection, one-time/expiry/attempt limits, changed identity denial, existing local workflows and complete corrections/approval. Run `npm run typecheck`, `npm run lint`, and `npm run build` too.

The migration creates deployment_identity/demo_mailbox and fictional-email triggers without changing existing accounts, applications or review states. Non-demo databases remain production-designated for simulator purposes; ordinary local CLI development continues. Rollback refuses if a demo identity or mailbox messages exist. Do not remove that protection on live data; use a separately reviewed recovery or dispose of the entire isolated demo environment. Existing earlier migration checks skip this empty layer only in explicitly disposable local databases.

To repeat the frontend-to-API smoke check after building (requires Node 24 and OpenSSL), run:

```sh
ALLOW_DISPOSABLE_DB_RESET=true DEMO_SMOKE_STARTER=true \
DEMO_TEST_DATABASE_URL=postgresql://operations:operations@localhost:5432/operations_email_demo_test \
node scripts/demo-email-smoke.cjs
```

It resets only that local *_demo_test database, starts temporary API/Next.js servers on 4012/3012 with a temporary trusted TLS certificate, checks production-runtime cookies, the banner on login/public applicant pages, the BFF mailbox restrictions, reveal, verification, draft and submission, then stops its own servers and removes its temporary certificate. It never prints codes/passwords or contacts hosted services. The API integration suite separately covers the full correction-to-approval flow. Interactive visual/keyboard review remains a manual check; HTTP smoke checks do not replace it.

