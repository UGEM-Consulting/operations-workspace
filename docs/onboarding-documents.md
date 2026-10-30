# Onboarding photos, documents and e-signatures

New hires complete a **Documents & signatures** step before they can submit an application:

1. **Selfie**: a clear photo of their face. It becomes the profile photo that IT sees.
2. **Selfie holding their ID**: seen only by the responsible manager and administrators, who compare the face and ID photo and check the name by eye. No automated face matching or biometric processing is done (Illinois BIPA).
3. **Company documents**: the NDA and SOP are signed with a typed legal name plus a signature, either drawn or adopted from the typed name. The Quick Contact List is acknowledged as read.

Photos and signatures are required to submit and to approve. The approving manager countersigns the NDA as part of the approval.

## Signing flow (ESIGN Act / UETA)

- The applicant gives one explicit consent to use electronic records and signatures. The checkbox is unticked by default, and the consent tells them they can ask for a paper copy.
- Each document has to be opened in full before it can be signed. When the applicant chooses **Open document** on the signing page, the web app sends an explicit request (`POST applicant/documents/:id/view`, with the usual BFF/CSRF checks) and the API records the first time (`document_views`). Fetching the file itself records nothing. The API refuses a signature without that record. The certificate states only what this shows: when the signer first opened the full document from the signing page.
- Each document has its own unticked statement, in English with a Russian translation. The English text governs.
- The applicant types their legal name in Latin letters, then either draws a signature or chooses **Type signature** and **Adopt typed signature**, which renders the typed name in a handwriting-style font on the same canvas (the keyboard-accessible option). They confirm in a dialog that warns the signature is legally binding.
- Each `document_signatures` row stores:
  - the exact consent and statement text;
  - the typed name, the signature image (PNG) and how it was made (`signatureMethod`: `DRAWN` or `TYPED`; older rows are `NULL`, meaning drawn);
  - the document's SHA-256 fingerprint;
  - the time, IP address and browser.
- Rows are append-only: a database trigger refuses UPDATE and DELETE. Published document versions (`company_documents`) are immutable in the same way.
- Signature images are checked before they are stored: a CRC-valid, non-animated 8-bit RGB/RGBA PNG of at most 2000 x 800 pixels whose image data inflates to exactly that size, followed by a trial embed into a PDF. The certificate never decodes an image that fails the structural check.
- The **signed copy** is generated on demand from these immutable records (a background job also saves a copy to the bucket; see "Bucket folders"). It is the original PDF, unchanged, followed by an electronic signature certificate that shows each signature's method. Applicants can download it after signing; managers and admins can download it from the application page. The applicant's copy omits the company countersigner's IP address and browser ("Recorded by UGEM"); staff copies and the database keep them. Signed-copy downloads are rate-limited.

## Saved signatures for approvers

Managers and administrators can save one countersigning signature on **Account security**, either drawn or adopted from their typed legal name, so they don't have to sign from scratch at every approval.

- **Saving.** Saving requires an explicit adoption statement, and the image passes the same checks as any signature.
- **Using it.** In the approval dialog the saved signature is offered first, and "Sign here instead" is always available. The approver still ticks the countersignature statement for each document.
- **What gets stored.** The name, image and method are copied into that document's signature row, marked as applied from a saved signature, and the certificate says so. Replacing or removing the saved signature never changes documents already signed.
- **Privacy.** Only the owner can see their saved signature.
- **When it is cleared.** An administrator changing the user's email, role, status or password, or resetting their two-step verification, clears it.
- **Audit.** Saving, removing and clearing are recorded as security events. The events hold metadata only, never the name or image.

Two-step verification for all staff (Settings → security policy) is recommended. A saved signature means anyone signed in as that approver can countersign without signing anything new.

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
- Applicants always sign the current version. A signature on an earlier version no longer satisfies submission or approval of an open application: the applicant is asked to sign the new version (in a correction round once submitted). Approved and rejected records are final and not re-evaluated. Signed copies keep the version that was signed.
- A document kind is required only once a version of it has been published.
- Never commit these PDFs to Git.

## Bucket folders

Each person's files are kept in one folder, named by their application ID (new hires) or driver ID. Names and other personal details are never used in paths. Blank company forms have their own folder.

```
applicants/<application id>/
  selfie/<photo id>.jpg
  id-selfie/<photo id>.jpg
  signed/nda-v1.pdf, sop-v1.pdf, contact-list-v1.pdf
drivers/<driver id>/
  documents/license|medical-card|work-authorization/<scan id>.pdf
  reports/mvr/<report id>.pdf
  signed/background-disclosure-v1.pdf, background-authorization-v1.pdf, clearinghouse-consent-v1.pdf
company-documents/
  onboarding/nda|sop|contact-list/<document id>.pdf
  driver-consents/background-disclosure|background-authorization|clearinghouse-consent/<document id>.pdf
```

- **Locating a person:** the application ID is on each new hire's application page, and the driver ID is in the driver's page address. Use either to find their folder in the Google Cloud console.
- **Signed copies:** a background job saves each signed copy into the person's `signed/` folder once it is complete. It runs at startup, then every 2 minutes.
  - The SOP, the Quick Contact List and drivers' consent forms are saved right after signing.
  - The NDA is saved after the manager countersigns at approval. If an application ends without a countersignature (rejected, or approved before countersigning existed), the applicant-signed copy is saved instead.
  - The job also saves copies for everyone who signed before it existed.
  - A saved copy is never changed. A newer document version is saved next to it, for example `nda-v2.pdf`.
  - Download buttons still generate copies from the signature records, so they keep working while a copy waits to be saved.
  - A copy that can't be saved (for example, its blank form is missing from the bucket) waits 10 minutes before the next try, then 20, 40 and so on, up to 6 hours. Other copies are saved meanwhile. The log shows only how many copies failed in each run.
  - Saved copies are the staff version, with the signer's IP address and browser. Copies signed in a draft that was never sent are saved too. They are kept like the signature records; deleting them waits for the retention job, which isn't authorized yet.
- **Files from before this layout** (`photos/`, `documents/`, `drivers/<id>/<scan>.pdf`, `driver-reports/`, `driver-consents/`) stay where they are and remain readable. Each record notes which layout its file uses.

## Storage and limits

- **Production:** `STORAGE_DRIVER=gcs`, with a private Google Cloud Storage bucket. The production API refuses to start without it, but operator commands (migrations, admin bootstrap) do not need it.
- **Development and tests:** `STORAGE_DRIVER=local` with `STORAGE_LOCAL_DIR` (for example `.storage`, which is Git-ignored) for fictional files only, or `none`, which turns the step off.
- **Photos:** re-encoded in the browser to a JPEG of at most 1600 px and 2.5 MB. The API then rewrites the JPEG on the server: it validates the segment structure, keeps the JFIF header and decoding segments, drops EXIF/GPS, XMP, ICC and other application segments, comments and anything after the end marker, and refuses frames over 8000 px per side. Camera metadata such as location is therefore stripped on the server even if a client skips the browser step. The applicant session and editability are checked before anything is stored. Applicants can take a photo with the front camera or choose one from their library.
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
6. Deploy the API. Migrations `OnboardingDocuments1792710000000` and `SignatureMethod1792750000000` run automatically. `SignatureMethod` only adds a nullable column; its rollback refuses while typed signatures exist.
7. Deploy the web app.
8. Publish the NDA, SOP and Quick Contact List on **Documents**.

## Not yet implemented

- **Retention:** no automatic deletion yet. Legal must set retention periods for ID selfies, rejected applicants' photos and signatures.
- **Email delivery:** signed copies are not emailed.
- **Admin deletion:** there is no admin action to delete an ID selfie.
