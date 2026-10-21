# Identity architecture and future expansion

## Current trust boundaries

Browser → same-origin Next.js BFF → NestJS → PostgreSQL. Next.js transports session cookies and renders API-provided permissions; it never decides staff business permissions or reads the database. The BFF shared secret authenticates the server boundary, not the user. Both the secret and a valid database-backed user session are required for protected API routes. Credential-bearing requests are JSON-only with an exact allowed Origin and a required non-simple header. No browser bearer tokens or localStorage authentication are used.

A global role guard denies endpoints without explicit role metadata. Every authorization check reloads status and role; session versions invalidate sessions after edits. Administrators manage internal staff only. Manager assignment checks must load the actual record and assignment from the database and call the object policy; never accept an assignment from a client merely to authorize that same client. IT staff cannot read dispatcher applications through the manager policy.

Sessions are persisted using the schema required by connect-pg-simple and signatures provided by express-session. Signing secret rotation invalidates all browser sessions. Session rows are private credentials and must be excluded from logs/exports. Future session listing or per-device revocation must not return stored IDs to other users. Concurrent account changes cannot resurrect privilege because sessions also carry a checked user authentication version.

## Dispatcher invitation principles

Applicants have no company email and are not rows in `users`. Future applicant and application tables need separate identifiers and an explicit assignment relationship to internal managers. Invitations will target the applicant's verified personal contact address.

Generate at least 32 random bytes with the platform cryptographic RNG. Deliver the token only through the approved invitation channel and store only its SHA-256 digest, expiration, intended application/applicant relationship, issuing staff user, and consumed/revoked timestamps. Never log the raw token or retain it in analytics. Redemption must compare the digest and atomically consume an unexpired, unused invitation in a transaction. Use generic responses to prevent enumeration, dedicated rate limiting, referrer controls, and no third-party scripts on redemption pages.

After redemption, issue a separate restricted applicant session bound to one applicant/application. Each read and write must verify that relationship in NestJS; staff roles and applicant sessions must never be interchangeable. The initial invitation is one-use only. Correction requests must not reactivate or reuse the consumed token: require an existing verified applicant session or a newly issued, independently verified access/recovery link with its own expiry and consumption state. Define recovery/contact verification and document-retention policies before implementing forms or uploads.

Milestone 3 implements invitations, verified applicant sessions, drafts and submission; see [dispatcher onboarding](dispatcher-onboarding.md). Milestone 4 corrections use independently verified returning applicant access, never a consumed invitation token; see [manager review](manager-review.md).

## Google Workspace SSO migration

Keep internal `User` IDs, roles and status stable. `passwordHash` is nullable so password authentication may be disabled per user after SSO enrollment. Add an external-identity table with a unique provider/issuer/subject mapping; do not use mutable email as the identity key. Use a maintained OpenID Connect client with authorization-code flow, PKCE, state, nonce, issuer/audience/signature validation, and verified-email checks. Restrict enrollment to an approved Google Workspace tenant/domain and a pre-provisioned or explicitly approved staff account. Do not grant SYSTEM_ADMIN based on an email suffix or auto-link an unverified email.

Complete the OIDC flow through the existing same-origin boundary and establish the same regenerated database session after successful verification. Existing NestJS guards and object policies remain authoritative. On enrollment, credential removal, role/status changes, or provider unlinking, revoke sessions and increment the authentication version. Plan administrator recovery and enforce the organization's MFA policy before turning off password login. Never automatically elevate an SSO user or create an administrator during first sign-in.

## Operational limits

The demo uses a fixed absolute session lifetime and conservative shared PostgreSQL login quotas. Production needs monitored edge limits, approved account provisioning/recovery, secret rotation, backups, and audit-event retention. Explicitly configure origins and trusted server secrets independently for preview and production. Do not weaken certificate verification, cookie attributes, or CSRF checks to make cross-site domains work.
