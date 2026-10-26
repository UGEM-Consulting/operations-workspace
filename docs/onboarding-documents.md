# Onboarding photos, documents and e-signatures

New hires complete a **Documents & signatures** step before they can submit an application:

1. **Selfie**: a clear photo of their face. It becomes the profile photo that IT sees.
2. **Selfie holding their ID**: seen only by the responsible manager and administrators, who compare the face and ID photo and check the name by eye. No automated face matching or biometric processing is done (Illinois BIPA).
3. **Company documents**: the NDA and SOP are signed with a typed legal name plus a drawn signature. The Quick Contact List is acknowledged as read.

Photos and signatures are required to submit and to approve. The approving manager countersigns the NDA as part of the approval.

## Signing flow (ESIGN Act / UETA)

- The applicant gives one explicit consent to use electronic records and signatures. The checkbox is unticked by default, and the consent tells them they can ask for a paper copy.
- Each document has to be opened in full before it can be signed. The API records the first time the applicant opens it (`document_views`) and refuses a signature without that record.
- Each document has its own unticked statement, in English with a Russian translation. The English text governs.
- The applicant types their legal name in Latin letters, draws a signature, and confirms in a dialog that warns the signature is legally binding.
- Each `document_signatures` row stores:
  - the exact consent and statement text;
  - the typed name and drawn signature (PNG);
  - the document's SHA-256 fingerprint;
  - the time, IP address and browser.
- Rows are append-only: a database trigger refuses UPDATE and DELETE. Published document versions (`company_documents`) are immutable in the same way.
- The **signed copy** is generated on demand from these immutable records. It is the original PDF, unchanged, followed by an electronic signature certificate. Applicants can download it after signing; managers and admins can download it from the application page.

## Who sees what

| Viewer | Selfie | ID selfie | Signed documents |
| --- | --- | --- | --- |
| The applicant (own record) | yes | yes | yes |
| Responsible manager, administrators | yes | yes | yes |
| Other managers | no | no | no |
| IT specialists | profile photo only, after approval | never | no |

- Staff see the photos as of the last submission. A photo replaced during an unsent correction stays private until the applicant resubmits, the same as correction drafts.
- Replaced photos that were never submitted are deleted from storage. Earlier submitted photos are kept as evidence of what was reviewed.
- Managers can request a new **Selfie photo**, **Selfie holding your ID** or **Document signatures** in a correction.

## Company documents

Managers and administrators publish NDA, SOP and Quick Contact List versions on **Documents** (`/onboarding/documents`).

- Each upload is a new version: a PDF of up to 3 MB, unencrypted.
- Applicants always sign the current version. Signed copies keep the version that was signed.
- A document kind is required only once a version of it has been published.
- Never commit these PDFs to Git.

## Storage and limits

- **Production:** `STORAGE_DRIVER=gcs`, with a private Google Cloud Storage bucket. The production API refuses to start without it, but operator commands (migrations, admin bootstrap) do not need it.
- **Development and tests:** `STORAGE_DRIVER=local` with `STORAGE_LOCAL_DIR` (for example `.storage`, which is Git-ignored) for fictional files only, or `none`, which turns the step off.
- **Photos:** re-encoded in the browser to a JPEG of at most 1600 px and 2.5 MB. This also strips camera metadata such as location.
- **Uploads:** sent as base64 JSON through the same-origin BFF. The BFF passes photo and PDF responses through with `no-store` caching.
- **Signature evidence:** the BFF forwards the signer's IP address (from Vercel's `x-forwarded-for`) and browser. The API trusts those headers only on requests carrying the BFF secret.

## Production setup (operator)

1. In Google Cloud, create a bucket with:
   - **uniform bucket-level access**;
   - **public access prevention enforced**;
   - a US region;
   - no public or CDN access.
2. Create a service account with **Storage Object User** (`roles/storage.objectUser`) on that bucket only. Do not grant it project-wide roles.
3. Create a JSON key for the service account and base64-encode it on one line. For example, in PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('key.json'))`.
4. In Render, set `STORAGE_DRIVER=gcs`, `GCS_BUCKET=<bucket name>` and `GCS_CREDENTIALS_BASE64=<encoded key>` as secret environment values.
5. Delete the local key file.
6. Deploy the API. Migration `OnboardingDocuments1792710000000` runs automatically.
7. Deploy the web app.
8. Publish the NDA, SOP and Quick Contact List on **Documents**.

## Not yet implemented

- **Retention:** no automatic deletion yet. Legal must set retention periods for ID selfies, rejected applicants' photos and signatures.
- **Email delivery:** signed copies are not emailed.
- **Admin deletion:** there is no admin action to delete an ID selfie.
