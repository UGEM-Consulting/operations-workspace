# Dispatcher manager review — Milestone 4

## State and data ownership

DispatcherApplication.status remains the authoritative current workflow state:

| From | To |
| --- | --- |
| INVITED | DRAFT |
| DRAFT | SUBMITTED |
| SUBMITTED | CHANGES_REQUESTED, APPROVED, REJECTED |
| CHANGES_REQUESTED | RESUBMITTED |
| RESUBMITTED | CHANGES_REQUESTED, APPROVED, REJECTED |
| APPROVED / REJECTED | No transitions |

Saving a draft is not a status transition. A first-time form submission first saves DRAFT, then submits; a direct API attempt to skip DRAFT is rejected. Correction saves retain CHANGES_REQUESTED. Retries of the immediately preceding submission return its existing state without an extra event; stale submissions from a prior correction cycle fail. No administrative override or automatic reopening exists. New approvals require explicit MC/team-lead/job-title confirmation; pre-existing approvals are preserved.

ApplicationReview stores application/reviewer foreign keys, decision type, reason, requested personal fields, prior/new status, resulting application version and timestamp. The review timestamp/actor identify the approval or rejection; there is no independent approval flag. A unique application/version constraint supplements transaction-level conflict checks. Review history is append-only through the API.

ApplicationSubmission preserves only each submitted personal-field revision, allowing old/new comparisons across multiple correction rounds. These restricted records contain personal data and need the same retention/access controls as the application. They are not generic audit payloads. ApplicationActivity remains the metadata-only audit/notification-ready event stream; review/submission writes and events commit atomically. Existing Milestone 3 submissions are backfilled in the migration.

## Review and correction security

The global staff guard and explicit onboarding role metadata remain in place. ReviewService independently checks active owner/admin scope against database-loaded assignments. Managers cannot review another manager's record. Administrators may review across managers, but cannot bypass workflow states. IT has no onboarding record/review access in this milestone, including approved records; the approved IT projection is a Milestone 5 task.

All review writes require an expected application version. The service locks the invitation, then reloads the application and checks its version/state before deciding. Applicant saves/submissions and invitation revocation use the same lock order. Two simultaneous reviews cannot both commit. Terminal records cannot be modified. Approval/rejection require explicit confirmation, reject/change requests require nonblank reasons, and change requests require an allowlisted nonempty set of correction fields. Review limits allow 30 attempts per staff user per minute, persisted in PostgreSQL; existing CSRF/BFF protections apply.

Applicant responses are explicitly projected. They expose the applicant's status/current fields and only the active correction reason/field list. Internal approval/rejection comments, reviewer identities and review/submission histories are not sent to applicants. A rejected applicant sees a generic closed status. HTML text is rendered with React escaping; comments are never injected as HTML.

During corrections, applicants may change only flagged first/last name, personal/work phone, American name, Telegram, MC, team lead or job title fields. Missing required fields are included in correction access so older records can be completed. Sending a different value for an unflagged field is rejected, even if UI controls are bypassed. Verified email remains immutable. Employment answers belong to the applicant submission; managers confirm or correct final assignments in the approval action. Approval requires validated employment values and explicit employment confirmation. The transaction preserves previous/final assignment values in the review record and updates the existing invitation assignment columns used by future IT onboarding. A correction draft is stored in the application's working fields; manager lists/detail/search use the latest submitted revision instead, so unsent corrections do not leak through search or lists. Final validation runs again on the merged form before resubmission.

## Returning access and notifications

Invitation tokens remain single-use. Initial access is bounded by invitation expiry. A correction request grants a separate 30-day applicantAccessUntil window, allowing correction after the original invitation expires. It neither resets the invitation token nor extends the applicant's one-hour session. Returning applicants use application reference + invited email + fresh verification, with the existing code/attempt/expiry controls. An existing valid applicant session may continue within the access window. Revocation still blocks access. Production verification remains fail-closed pending an approved email delivery implementation.

The MVP notifications are in-portal: submitted/resubmitted rows appear in manager review queues, active correction instructions appear on the applicant page, and approved records show Ready for IT onboarding. A status refresh or page reload fetches new notices; there is no realtime subscription or read/unread notification inbox. Durable APPLICATION_SUBMITTED, APPLICATION_RESUBMITTED, APPLICATION_CHANGES_REQUESTED, APPLICATION_APPROVED and APPLICATION_REJECTED activity events prepare future event consumption without claiming external delivery.

## Queue and Milestone 5

The new `/onboarding/review-queue` uses scoped SQL filtering, parameterized search, allowlisted sorting and bounded pages (maximum 50 rows). Stable ID ordering breaks ties. The AWAITING_REVIEW filter is a query grouping of SUBMITTED/RESUBMITTED, not another persisted status. Counts cover all authorized rows. The older `/onboarding/applications` array route remains for compatibility and is capped at 200; the review UI does not use it. Invitation management retains its existing 200-row limit.

`readyForIt` is computed from APPROVED. The approved application plus its approval decision/reviewer/timestamp is the reliable input for the future IT queue. Authorized review details include both phones and an American-name-based proposedDisplayName, with the legal name retained separately. Missing names yield no proposal; historical approval status remains unchanged. Milestone 5 must introduce a least-privilege approved-record projection for IT and idempotent provisioning/task creation, plus explicit IT_IN_PROGRESS/COMPLETED transitions and authorization. No tasks, Google Workspace accounts, RingCentral integration, document uploads or external messages are created here.

## Migration and verification

ApplicationReview1792620000000 expands status constraints, initializes access windows, creates decision and submission tables/indexes, and backfills submitted revisions. Its down migration refuses to discard review decisions or advanced states. There is no production-safe automatic conversion back to Milestone 3; rollback after review use requires a separately reviewed recovery plan.

Tests cover the full workflow and privacy/concurrency/validation boundaries. `scripts/review-smoke.cjs` verifies the running local Next.js BFF/API with a fictional account and requires explicit local opt-in. `scripts/review-migration-check.cjs` requires explicit destructive opt-in and a local *_test database, verifying backfill, rollback/reapply and refusal to drop decisions. Never use either against deployed or real employee data. UI dialogs and responsive layouts still need manual browser QA when the browser tool cannot initialize.
