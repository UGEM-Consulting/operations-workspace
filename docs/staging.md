# Staging

Staging is a hosted copy of UGEM Workspace for staff to test changes before they reach production. The `dev` branch deploys to staging; `main` deploys to production.

It runs with production rules (HTTPS, secure cookies, verified TLS, real SMTP) and its own Render API service, Render PostgreSQL database and Vercel web deployment. Staff may test with their own email address and phone number there. **Never copy production data, backups or files into staging.**

## What is different from production

- `DEPLOYMENT_PURPOSE=staging` on both the API and the web app.
- The web app shows a **Staging** banner on every page, adds "(Staging)" to page titles and asks search engines not to index the site.
- Storage is optional. Without a bucket (`STORAGE_DRIVER=none`) photos and NDA/SOP signatures are not asked for, and applications can be submitted without them. To test documents, create a **separate** private bucket and service account for staging; never point staging at the production bucket.
- Every secret is its own: never reuse a production value.
- `seed:demo` stays development-only. Create the first staging administrator with `admin:bootstrap` (README), against the staging database.

## Render API service

Same build and start commands as production (`render.yaml`):

- Build: `npm ci --include=dev && npm run build --workspace=@operations/api`
- Start: `npm run start:render --workspace=@operations/api` (applies pending migrations to the staging database)
- Health check path: `/api/health`
- Branch: `dev`

| Variable | Value |
| --- | --- |
| `NODE_VERSION` | `24` |
| `NODE_ENV` | `production` |
| `DEPLOYMENT_PURPOSE` | `staging` |
| `DATABASE_URL` | The staging database's **internal** URL |
| `DATABASE_SSL` | `false` for the internal URL |
| `WEB_ORIGIN` | The staging web address, e.g. `https://staging.workspace.ugemconsulting.com` (origin only, HTTPS) |
| `CORS_ORIGINS` | The same staging web address |
| `SESSION_SECRET` | New random value (at least 32 characters) |
| `BFF_SHARED_SECRET` | New random value; must match the staging web app and differ from `SESSION_SECRET` |
| `SESSION_TTL_SECONDS` | `28800` |
| `EMAIL_DELIVERY`, `SMTP_*`, `EMAIL_FROM`, `STAFF_EMAIL_FROM` | Same rules as production ([email delivery](email-delivery.md)). A separate mailbox or app password is preferred so staging can be switched off on its own. |
| `STORAGE_DRIVER` | `none`, or `gcs` with a staging-only `GCS_BUCKET` and `GCS_CREDENTIALS_BASE64` |
| `MFA_ENCRYPTION_KEY` | New value (once two-step verification is deployed); never the production key |
| `PII_ENCRYPTION_KEY` | New value (once driver applications are deployed); never the production key |
| `TELEGRAM_*` | Once applicant Telegram updates are deployed: a **separate test bot** (for example *UGEM Hiring Staging*). Staging and production must not share one bot, because each reads the bot's pending messages and would take the other's. |

Generate a random secret locally with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Vercel web

Use either a separate Vercel project or the existing project with `dev` deployments assigned a staging domain. In both cases set these for the staging deployments only (in a shared project, scope them to the `dev` branch/Preview environment):

| Variable | Value |
| --- | --- |
| `API_BASE_URL` | The staging Render API origin (HTTPS, no path) |
| `BFF_SHARED_SECRET` | Same value as the staging API |
| `WEB_ORIGIN` | The staging web address (same as the API's `WEB_ORIGIN`) |
| `DEPLOYMENT_PURPOSE` | `staging` |

Keep Fluid Compute on, as in production. Vercel Deployment Protection may stay on for staging; it only adds a Vercel sign-in in front of the site.

## Deploying

Nothing deploys automatically from this repository. After merging into `dev` and pushing, deploy the staging API in Render (migrations run on start), then redeploy the staging web app.
