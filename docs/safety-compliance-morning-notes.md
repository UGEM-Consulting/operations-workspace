# Safety compliance work: morning notes

Branch: `feature/safety-compliance` (also on `dev-ud80v9` for Phase 1). Nothing deployed, no cloud resources, no production data. All tests ran against a disposable local `operations_safety_test` database with fictional data.

## Environment
- The Phase 1 commit `cbaaf62` from the earlier session was **not** available in this checkout (never pushed). Phase 1 was rebuilt from scratch, so the hash differs.
- Local PostgreSQL 16, role `operations`, database `operations_safety_test`.

## Phase 1: Expiring documents (no migration)
**Built:** `GET /safety/expiring` (`SafetyService.expiring`), listing verified licence, medical card and work authorization scans of open drivers that expired or expire within 60 days (Eastern date), soonest first. Dates only, never numbers. New `expiring` navigation item (all Safety roles + admin) with a sidebar count (`workspace/counts`). Page: Safety › Expiring documents. No emails or messages are sent.
**Tests ran:** `safety.integration.spec.ts` new test (unverified/far dates excluded, ordering, expired flag, no numbers in the response, 403 for dispatch, closed driver drops out).
**Not tested:** the `workspace/counts` wiring (that suite does not mount the workspace module); the web page (typecheck/lint only, not opened in a browser).
**Questions:** Is 60 days right? Should expiring *clearance* items (drug test, Clearinghouse, medical registry) and the MVR also appear? Should the list include a "request new scan" action?

## Phase 2: Mark a driver as Left (migration `DriverLeft1793040000000`)
**Built:** `POST safety/drivers/:id/left` {version, leftOn, reason}. Allowed for the Safety manager, administrators and the driver's current owner, only from APPROVED or CLEARED. Closes the record (closedAt = last day, midday UTC), ends the open owner row and open dispatch assignment on that day (same-day = +1 ms rule), revokes links, frees phone/email. A dispatcher is no longer blocked by that driver. The `LEFT` event holds only `from` and `assignmentEnded`, never the reason or date. Web: "Mark as left" button and dialog, info alert on a Left driver. The migration only widens the event CHECK; rollback refuses while any Left driver or LEFT event exists.
**Tests ran:** `safety.integration.spec.ts` (31 pass: roles, validation, future/pre-clearance dates, owner/assignment ending, event content, closed record, owner self-service, rollback refusal), plus every suite that counts migrations (dispatch, lists, documents, offboarding, retire-demo). Full API run: **29 suites, 485 tests, 0 failed, 0 skipped** with `TEST_DATABASE_URL` set.
**Not tested:** the web dialog in a browser.
**Questions:** Should a Left driver be reopenable (e.g. rehire)? Should Dispatch/team leads be told when a driver they work with leaves? Should the Safety lead also be allowed to mark Left?

## Phases 3 to 6: NOT STARTED
- Phase 3 yearly reviews / annual MVR
- Phase 4 ongoing drug and alcohol testing (results only)
- Phase 5 accidents, violations, inspections
- Phase 6 owner-operator truck, lease and insurance documents + trucks list

I stopped after Phase 2 on purpose. Each of these adds tables, retention-sensitive data (test results, accident records, insurance documents) and UI that AGENTS.md says should go through the Design System first and that I could not access. Phase 4/5 also need your decision on what may be stored (results only? no narratives?) and who may read it. Phase 6 needs a decision on private storage for new document kinds (the current upload paths are authorized only for the listed kinds).

## Phase 7 questions (unchanged, need your decision)
Retention policy and deletion job, narrowing which roles read all drivers, final wording of the consent PDFs.
