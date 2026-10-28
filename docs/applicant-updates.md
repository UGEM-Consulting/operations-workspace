# Applicant status updates (email and Telegram)

Authorized by the user on 2026-10-27: applicants choose how they hear about decisions, by email, Telegram or both.

## What applicants see

On the **Review & submit** step, and on the status page afterwards, the applicant chooses **Email** (to their verified address, on by default) and/or **Telegram**. At least one must stay on. To use Telegram they press **Connect Telegram**, open the one-time link (it opens the company bot), press **Start** in Telegram, then **Check connection**. They can disconnect on the page, or send `/stop` to the bot.

A message is sent when a manager **requests changes**, **approves** or **rejects** the application. Each message gives the application reference and the resume page link (`<first WEB_ORIGIN>/apply/resume`), so applicants no longer have to keep the reference themselves. It never contains names, phone numbers, employment, Telegram handles or reviewer reasons; the reference alone opens nothing, because resuming still needs a fresh code sent to the verified email.

## How it works

- **Preferences** live in `applicant_update_settings` (one row per application; no row means email only). A CHECK keeps at least one channel on.
- **Telegram connect links** are 32 random bytes (base64url) in `https://t.me/<bot>?start=<token>`. Only the SHA-256 is stored (`telegram_link_tokens`); a link expires after 30 minutes and is consumed once under a row lock. Ten links per application per hour.
- **No webhook.** Telegram cannot pass the API's BFF/CSRF boundary, so the API reads the bot's pending updates with `getUpdates` only when an applicant presses **Check connection** (30 checks per application per 10 minutes). A PostgreSQL advisory lock (42002031) serializes polling across instances, and `telegram_poll_state` stores the offset so each update is handled once. This works on Render Free because the applicant is using the site when they connect.
- **Delivery outbox.** The decision transaction writes one `applicant_update_deliveries` row per chosen channel (`PENDING`, or `SKIPPED` with `DISABLED`/`NOT_CONNECTED`). After the decision commits, the rows are sent in the background (drained on shutdown) and marked `SENT` or `FAILED` with a safe code (`EAUTH`, `FORBIDDEN`, `TIMEOUT`, …). The table stores no message text or addresses. A failed message never affects the decision. There is no automatic retry worker yet.
- **Logs** contain only safe failure codes. The bot token is part of Telegram request URLs, so Telegram errors are reduced to codes and never logged.
- Activity events (metadata only): `UPDATE_PREFERENCES_CHANGED`, `TELEGRAM_CONNECTED`, `TELEGRAM_DISCONNECTED`.

## Settings

| Variable | Meaning |
| --- | --- |
| `EMAIL_DELIVERY=smtp` | Status emails use the same Google Workspace mailbox and rules as verification codes ([email delivery](email-delivery.md)). |
| `TELEGRAM_DELIVERY` | `none` (default) or `bot`. |
| `TELEGRAM_BOT_TOKEN` | Token from BotFather. Secret: store it only in Render's environment settings. |
| `TELEGRAM_BOT_USERNAME` | The bot's username, ending in `bot` (used in connect links). |
| `TELEGRAM_API_BASE` | Defaults to `https://api.telegram.org`, the only value allowed in production. Outside production only a local fake server on localhost is allowed, so development and tests never reach Telegram. |

## Turning Telegram on (operator steps, not automated)

1. In Telegram, open **@BotFather**, send `/newbot`, and name it *UGEM Hiring* (username like `ugem_hiring_bot`; enter it in `TELEGRAM_BOT_USERNAME` without the @). Keep the token private.
2. Optional: `/setdescription` and `/setuserpic` so applicants recognise it. Do **not** set a webhook; the API reads updates itself.
3. In Render, add `TELEGRAM_DELIVERY=bot`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`, then redeploy the API. Migration `ApplicantUpdates1792730000000` runs automatically; its rollback refuses while any preference or delivery record exists.
4. Redeploy the web app (the proxy allows the new `applicant/updates` routes).

Until step 3, the Telegram option shows *Not available yet* and everyone gets email.
