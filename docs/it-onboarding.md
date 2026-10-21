# IT onboarding — Milestone 5

## Approval and snapshot boundary

ReviewService creates the approval, authoritative employment assignments, immutable ItOnboardingRequest profile, six tasks and activity events using one EntityManager transaction. Failure anywhere rolls back the approval. Unique applicationId/approvalId constraints prevent duplicate requests; task request/key uniqueness prevents duplicate checklist entries. Historical approvals are untouched and are not automatically backfilled. A future approved historical-import process would need separate authorization and validation, especially where required American names/work phones are absent.

The snapshot contains only approved legal/American names, American display-name proposal, personal email, distinct personal/work phone values and final manager-approved employment details. It does not include draft revisions, internal review reasons, session identifiers or invitation credentials. Legal names are never replaced by American names. Snapshot fields are not editable from the IT API.

IT_SPECIALIST and SYSTEM_ADMIN may read/update requests. Every access checks the approved application and approval-decision relationship. Managers cannot operate IT endpoints; owner-scoped application review details expose a progress summary. Notifications are visible/readable only to their recipient. The existing global guard, active staff/session checks, exact Origin/JSON/non-simple-header CSRF checks, BFF allowlist and server secret remain authoritative.

## Request, checklist and contact state

The request belongs to an APPROVED application; the application remains APPROVED. Request status is derived: completedAt → COMPLETED; otherwise any Blocked task → BLOCKED; otherwise any non-Pending task → IN_PROGRESS; otherwise PENDING. There is no competing application status/approval flag.

The fixed manual checklist covers Google Workspace, Dispatch group membership, RingCentral, SMS, call recording and approved business software. Each task can be Pending, In Progress, Blocked or Completed until request completion. Blocked needs a reason. This records manual fictional attestations, not external account/API operations or evidence that real services were configured. Business-software authorization remains a manual company policy process recorded in task notes. Notes must never contain credentials.

The applicant work phone is displayed as Applicant Provided until an IT/admin user explicitly records verification. Actor and timestamp are stored. The actual assigned RingCentral number is a separate validated field and may equal or differ from the applicant work phone. Neither contact updates nor checklist changes overwrite personal/work numbers in the snapshot/application. RingCentral cannot be completed without its assigned number; the last task cannot complete the request until work-phone verification and an assigned number exist.

All updates lock the request, reject stale expected versions and increment version. Completed requests are immutable for every role. Status, contact-verification and completion events retain actor/time with metadata; phone values and free-text notes are not copied into audit payloads. Existing application/review histories remain intact.

## Completion and portal notices

The final task update, completedAt, IT/application activity and a unique PortalNotification for the responsible manager commit together. Concurrent/repeated final updates cannot create multiple completions or notifications. A completed request cannot be reopened. Manager dashboard notices appear on page refresh and can be marked read; this is a durable in-portal notice, not an email/SMS/realtime delivery claim. Lists show the most recent 50 notifications and total unread count. Admin reviewers do not redirect a notification away from the owning/assigned manager.

## Persistence and deployment

ItOnboarding1792650000000 creates it_onboarding_requests, it_onboarding_tasks, it_onboarding_activity and portal_notifications with UUID foreign keys, uniqueness, timestamps and indexes. Runtime/CLI entities are registered in the shared TypeORM options. Synchronization and automatic migrations remain disabled. Apply migrations before starting an updated release. Down refuses to drop any IT request/history; rollback after use requires a reviewed recovery plan. Disposable-test checks truncate only an explicitly selected local *_test database.

No new secrets/dependencies, cloud resources or external accounts are required for this manual workflow. Next.js and NestJS retain independent builds and the same-origin production cookie boundary for Vercel/Render. Production applicant verification remains disabled until approved email delivery exists. Production staff/demo account provisioning, environment setup, backup/retention, dependency advisory review, edge limits and interactive browser QA remain prerequisites for a hosted demonstration or broader use.
