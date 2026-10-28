# Applicant email delivery

Applicants verify their personal email with an 8-digit code before they can open an application. Delivery is selected with `EMAIL_DELIVERY` in the API environment.

| Mode | Where | Behaviour |
| --- | --- | --- |
| `none` (default) | Local development and tests | No email. Codes are issued privately with `npm run verification:demo -- <reference>`. In production this mode refuses verification (503) while the rest of the API keeps working. |
| `smtp` | Production (Google Workspace) and local development (Mailpit) | Codes are emailed. |

Outside production, only fictional `@example.test` addresses are accepted, and SMTP may only target a local inbox on `localhost`, so development can never email real people. Production accepts real addresses.

## How delivery works

- `POST /applicant/begin` makes the same single database write for every request: a 10-minute challenge row. Only when the email matches an available invitation (or a returning application) does it carry a code hash. The response is identical for matched and unmatched requests and reports `delivery: "email"` or `"manual"`, which the applicant page uses for its instructions.
- After the response, a tracked background task marks the invitation opened, sends the email, and records the outcome as a metadata-only `VERIFICATION_EMAIL_SENT` or `VERIFICATION_EMAIL_FAILED` activity event. Unmatched requests send nothing.
- Temporary SMTP failures are retried twice (after 1 s and 4 s). Credential, address and message errors (`EAUTH`, `EENVELOPE`, `EMESSAGE`) are not retried. On shutdown or redeploy the API waits up to 15 seconds for in-flight sends. A failed send leaves the applicant without a code: the page tells them to check spam or select **Start again**, and staff can see the failed outcome in the application's activity.
- The email contains only the code and expiry guidance: never invitation links, tokens, application references or applicant details.
- Request rate limits are per client address (the IP the BFF forwards), not per email, so nobody can lock a specific applicant out; see [dispatcher onboarding](dispatcher-onboarding.md#boundary-abuse-protection-and-operations).
- Verification itself is unchanged: hashed codes, five attempts per challenge, row-locked atomic claiming, one-hour applicant sessions.
- Logs contain only an allowlisted Nodemailer code (`EAUTH`, `ECONNECTION`, `ETIMEDOUT`, …, otherwise `SEND_FAILED`), never addresses, codes or server replies. At startup the API checks the SMTP connection and logs `SMTP connection verified` or the failure code; startup is not blocked.

## Sending limits

An open invitation link (no expected email) could otherwise be used to mail any number of addresses and exhaust the Workspace sending quota. After the response, and only for matched requests, the background task checks these PostgreSQL counters before sending (constants `SEND_LIMITS` in `modules/onboarding/onboarding.service.ts`):

| Limit | Value | Code |
| --- | --- | --- |
| Codes mailed to one address (any invitation or resume) | 10 per day | `ADDRESS_DAILY_LIMIT` |
| Distinct addresses per open invitation link (an address once admitted keeps working) | 3 per day | `INVITATION_ADDRESS_LIMIT` |
| All verification emails | 400 per day | `DAILY_BUDGET` |

A refused send leaves the response unchanged (matched and unmatched requests stay indistinguishable), records `VERIFICATION_EMAIL_FAILED` and logs only the code above. The applicant sees the usual "check spam or start again" guidance. Status update emails are not counted against these limits. The budget is a constant; changing it needs a code change (no environment setting yet).

Invitation links are `/apply#<token>`. The URL fragment never leaves the browser, so tokens cannot appear in hosting, CDN or APM request logs or in Referer headers. The page keeps the token in memory and removes it from the address bar.

## Production configuration (Google Workspace)

Prerequisites, done once by a Workspace administrator:

1. A dedicated Workspace user to send from, e.g. `onboarding@ugemconsulting.com`.
2. 2-Step Verification enabled for that user, then an app password created at <https://myaccount.google.com/apppasswords>.
3. DNS: SPF (`include:_spf.google.com`), DKIM (`google._domainkey`) and a DMARC record (`_dmarc`, start with `p=none`).

Render API environment (Settings → Environment; never commit these). Set `EMAIL_DELIVERY=smtp` last, after the other values exist, because the API refuses to start with incomplete SMTP settings:

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=onboarding@ugemconsulting.com
SMTP_PASSWORD=<16-character app password>
EMAIL_FROM=UGEM Operations <onboarding@ugemconsulting.com>
EMAIL_DELIVERY=smtp
```

Validation fails closed: production SMTP must authenticate on TLS port 465 (implicit TLS) or 587 (STARTTLS required), with TLS 1.2+ and certificate verification. `EMAIL_FROM` must be exactly one address, optionally with a display name, and no line breaks.

Operational notes:

- Google Workspace accounts send at most about 2,000 messages per day.
- Every message is kept in the sending account's **Sent** folder. Restrict who can sign in to that mailbox, or add a retention rule, because it contains recent codes.
- Rotate the app password by creating a new one, updating Render, redeploying, then revoking the old one. Until the update, sends fail with `EAUTH`.

## Local development with Mailpit

[Mailpit](https://mailpit.axllent.org/) is a local inbox that captures every message; nothing leaves your machine.

```dotenv
# apps/api/.env
EMAIL_DELIVERY=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
EMAIL_FROM=Operations Local <no-reply@example.test>
```

Start Mailpit (`mailpit --listen 127.0.0.1:8025 --smtp 127.0.0.1:1025`), restart the API, and open <http://localhost:8025>.

## Tests

`test/email-delivery.spec.ts` covers configuration validation, retired demo settings, code format, message content, retries, shutdown draining and log sanitising. `test/email-delivery.integration.spec.ts` (requires `TEST_DATABASE_URL`) covers fragment invitation links, sent and failed outcomes, identical responses for unmatched emails, no delivery for unknown, revoked or claimed invitations, the sending limits above, and fictional-only enforcement outside production. It uses a captured transport rather than a real SMTP server.

## Status update emails

The same mailbox and rules also send applicant decision updates (changes requested, approved, rejected) when the applicant chose email. See [applicant updates](applicant-updates.md).
