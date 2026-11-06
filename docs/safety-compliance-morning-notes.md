# Safety compliance work: morning notes

Branch: `feature/safety-compliance` (Phase 1 is also on `dev-ud80v9`). Commits: Phase 1 `d20da2b`/tests, Phase 2, then one commit per phase 3-6. Nothing deployed, no cloud resources, no production data. All tests ran against a disposable local `operations_safety_test` database with fictional data.

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

## Phase 3: Yearly reviews and annual MVR (`DriverAnnualReviews1793050000000`)
**Built:** `POST safety/drivers/:id/annual-reviews` {version, reviewedOn, outcome QUALIFIED|NOT_QUALIFIED, note, mvr {file, pulledOn, paperAuthorization}}. Cleared drivers only. The owner, Safety manager and administrators record; every Safety role reads. A new MVR PDF is required when storage is enabled (pulled in the last 90 days, driver's signed or paper authorization, same rules as the screening MVR) and is stored as an ordinary `driver_reports` row of kind `ANNUAL_MVR`, so the sweeper keeps it. Reviews are append-only (trigger). Due = 365 days after the last review (or clearance); `GET safety/due` lists reviews due within 60 days, overdue, or whose last outcome was Not qualified. Web: Yearly review card on the driver page; section on Expiring documents. Event holds outcome + withMvr, never the note.
**Tests ran:** new integration test (roles, validation, MVR requirements, due list, history, event content, append-only) and the rollback refusal.
**Questions:** Should the review be blocked/flagged on the dispatch side when a driver is Not qualified? Should the Safety lead be allowed to record reviews?

## Phase 4: Drug and alcohol testing, results only (`DriverTesting1793060000000`)
**Built:** `POST safety/drivers/:id/tests` {kind DRUG|ALCOHOL, reason RANDOM|POST_ACCIDENT|REASONABLE_SUSPICION|RETURN_TO_DUTY|FOLLOW_UP, testedOn, result NEGATIVE|NOT_NEGATIVE|CANCELLED|REFUSED, note}. Owner, Safety manager and admins record (cleared drivers, dated on/after clearance); **only the manager/admin voids** (`.../tests/:id/void`, reason required, entry stays). Nothing else is stored (no substances, levels, lab files). A driver whose latest standing result of a kind is not negative or a refusal appears on the Safety follow-up list until a later negative of that kind. Events hold kind and reason, never result, date or note.
**Tests ran:** new integration test + rollback refusal. **Not built:** random selection/scheduling and consortium pool tracking.
**Questions:** Is a random-selection list needed? Should a non-negative result also notify the dispatcher/team lead?

## Phase 5: Accidents, violations, inspections (`DriverIncidents1793070000000`)
**Built:** `POST safety/drivers/:id/incidents` (ACCIDENT: preventable YES/NO/UNDETERMINED, injuries, fatalities, tow-away; VIOLATION: disposition PENDING/CONVICTED/DISMISSED; INSPECTION: out of service, violation count) plus state, one-line summary (200), note. DB CHECKs keep fields to their kind. Same permissions as Phase 4. `.../incidents/:id/settle` sets an undetermined preventability or a pending violation outcome once; `.../void` (manager) keeps the entry. Open ones appear on the follow-up list. Events hold the kind only. No other people's names, medical details or police report numbers are collected (hint text says so).
**Tests ran:** new integration test + rollback refusal.
**Questions:** Do you want DOT-recordable accident flags/rates reported? Crash register export?

## Phase 6: Owner-operator trucks, lease, insurance, registration (`OwnerOperatorTrucks1793080000000`)
**Built:** `driver_trucks` (unit, VIN validated 17 chars no I/O/Q and unique while current, year, make, plate+state, archive) and `driver_owner_documents` (LEASE, INSURANCE, REGISTRATION PDFs in private storage at `drivers/<driver>/owner-operator/<kind>/<id>.pdf`; expiration typed by the uploader, required except for a lease; a new file replaces the current one and the old row/file is kept). Routes under `safety/drivers/:id/trucks` plus `GET safety/trucks`. Only for OWNER_OPERATOR drivers who are APPROVED or CLEARED; leads, manager, admins and the driver's owner change; every Safety role reads; each file open is rate-limited and recorded. Insurance/registration expiries feed Expiring documents and the sidebar count. ScanSweeper got a rule that removes only unreferenced owner-operator files. Web: Truck and documents card, Safety › Trucks page.
**Tests ran:** new integration test, sweeper test extended, rollback refusal.
**Authorization to confirm:** AGENTS.md limits uploads to listed kinds. You asked me to build this phase, so I treated lease/insurance/registration PDFs as authorized; please confirm and I will add it to AGENTS.md (I did not edit AGENTS.md).
**Not built:** company-owned trucks, linking a truck to a dispatch assignment (assignments still carry free-text `truck`), insurance required for clearance, policy numbers (deliberately not stored).

## Permissions I chose (change any time)
Record/settle: current owner + Safety manager + admins (Phases 3-5), plus Safety leads for trucks. Void: Safety manager + admins only, so the person who enters a result cannot hide it. Read: all Safety roles and admins (unchanged). No new access for dispatch, team leads or IT.

## Test status
Full run on the final commit: **29 suites, 489 tests; 473 pass, 16 fail**. All 16 failures are in `existing-dispatchers.integration.spec.ts` and `offboarding.integration.spec.ts`. I confirmed they fail identically on the Phase 5 commit and are **not caused by this work**: those tests build "today" from the UTC date (`new Date().toISOString().slice(0, 10)`), which is a day ahead of the US date between about 19:00 and midnight Eastern, so "last day in the future" is refused. They passed earlier in the session (before 19:00 ET). Fix: use `usDay('latest')` in those tests. I did not change them. No test was skipped. Typecheck, lint and `npm run build` pass. The web pages were not opened in a browser.

## Phase 7 questions (unchanged, need your decision)
Retention policy and deletion job, narrowing which roles read all drivers, final wording of the consent PDFs.
