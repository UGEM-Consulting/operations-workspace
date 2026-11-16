/**
 * Keeping records (section 34: RetentionScheduleScreen, RetentionDueScreen, RetentionHoldScreen, RetentionLogScreen;
 * approved 2026-11-16). How long each kind of record is kept, at the legal minimums the user chose on 2026-11-13, for their
 * adviser to check before deleting is turned on. The periods are dates in US Eastern time.
 */
export type RetentionKind = 'APPLICATIONS' | 'DRIVER_APPLICATIONS' | 'DRIVER_FILES' | 'TESTS' | 'MEMBERS' | 'FILES';
export type Subject = 'APPLICATION' | 'INVITATION' | 'DRIVER' | 'MEMBER';
export const SUBJECTS = ['APPLICATION', 'INVITATION', 'DRIVER', 'MEMBER'] as const;
export const RETENTION_KINDS: { kind: RetentionKind; label: string; period: string; why: string }[] = [
  { kind: 'APPLICATIONS', label: 'Dispatcher applications never finished or not approved', period: '2 years after the last change', why: 'Your choice; EEOC asks for 1 year' },
  { kind: 'DRIVER_APPLICATIONS', label: 'Driver applications not hired (rejected or withdrawn)', period: '2 years after the decision', why: 'Your choice; EEOC asks for 1 year, FCRA notices 2 years' },
  { kind: 'DRIVER_FILES', label: 'Driver qualification files', period: '3 years after the driver leaves', why: '49 CFR 391.51' },
  { kind: 'TESTS', label: 'Drug and alcohol test results', period: '5 years after the test', why: '49 CFR 382.401 (5 years for positives and refusals)' },
  { kind: 'MEMBERS', label: 'Dispatchers, supports and updaters who left', period: '3 years after their last day', why: 'Your choice' },
  { kind: 'FILES', label: 'Replaced scans and photos', period: 'With the record they belong to', why: 'Never on their own' },
];
/** Days between a record showing as due and its deletion, and between turning deleting on and the first deletion. */
export const NOTICE_DAYS = 14;
/** The longest a hold may run at once; it can be extended. */
export const HOLD_MAX_DAYS = 731;

const eastern = (column: string) => `(${column} AT TIME ZONE 'America/New_York')::date`;
const lastTest = `(SELECT max(t."testedOn") FROM driver_tests t WHERE t."driverId" = d.id)`;
/**
 * Every record some rule will delete one day, with the day it becomes due. Records of anyone working here, on leave or
 * leaving, drivers still on the road, and someone whose later record came back are never here. A driver file waits for its
 * test results' own five years, since they are deleted with it.
 */
export const CANDIDATES_SQL = `
 SELECT 'APPLICATIONS' AS kind, 'APPLICATION' AS subject, a.id,
  coalesce(nullif(trim(concat_ws(' ', a.fields->>'preferredAmericanFirstName', a.fields->>'preferredAmericanLastName')), ''), nullif(trim(concat_ws(' ', a.fields->>'firstName', a.fields->>'lastName')), ''), i.email, 'No name given') AS name,
  'Application ' || left(a.id::text, 8) AS detail, CASE WHEN a.status = 'REJECTED' THEN 'Dispatcher application, not approved' ELSE 'Dispatcher application, never finished' END AS what,
  'Last change' AS basis, ${eastern('greatest(a."updatedAt", coalesce(i."revokedAt", a."updatedAt"))')} AS "basisOn",
  (${eastern('greatest(a."updatedAt", coalesce(i."revokedAt", a."updatedAt"))')} + interval '2 years')::date AS "dueOn"
 FROM dispatcher_applications a JOIN invitations i ON i.id = a."invitationId"
 WHERE a.status <> 'APPROVED' AND i."catchUpMemberId" IS NULL AND NOT EXISTS (SELECT 1 FROM dispatch_members m WHERE m."applicationId" = a.id)
  AND (a.status = 'REJECTED' OR i."revokedAt" IS NOT NULL OR (a.status IN ('INVITED','DRAFT','CHANGES_REQUESTED') AND a."applicantAccessUntil" < now()))
 UNION ALL
 SELECT 'APPLICATIONS', 'INVITATION', i.id, coalesce(i."expectedEmail", i.email, 'Invitation nobody used'), 'Invitation', 'Dispatcher invitation, never used',
  CASE WHEN i."revokedAt" IS NULL THEN 'Expired' ELSE 'Revoked' END, ${eastern('coalesce(i."revokedAt", i."expiresAt")')}, (${eastern('coalesce(i."revokedAt", i."expiresAt")')} + interval '2 years')::date
 FROM invitations i WHERE i."catchUpMemberId" IS NULL AND NOT EXISTS (SELECT 1 FROM dispatcher_applications a WHERE a."invitationId" = i.id) AND (i."revokedAt" IS NOT NULL OR i."expiresAt" < now())
 UNION ALL
 SELECT CASE WHEN d.status = 'LEFT' THEN 'DRIVER_FILES' ELSE 'DRIVER_APPLICATIONS' END, 'DRIVER', d.id, d."firstName" || ' ' || d."lastName",
  CASE d.status WHEN 'LEFT' THEN 'Driver, left' WHEN 'REJECTED' THEN 'Driver, rejected' ELSE 'Driver, withdrawn' END,
  CASE WHEN d.status = 'LEFT' THEN 'Driver qualification file' ELSE 'Driver application' END,
  CASE WHEN d.status = 'LEFT' THEN 'Left' ELSE 'Decided' END, ${eastern('d."closedAt"')},
  greatest((${eastern('d."closedAt"')} + CASE WHEN d.status = 'LEFT' THEN interval '3 years' ELSE interval '2 years' END)::date, coalesce((${lastTest} + interval '5 years')::date, '-infinity'::date))
 FROM drivers d WHERE d."closedAt" IS NOT NULL AND (d.status = 'LEFT' OR (d.status IN ('REJECTED','WITHDRAWN') AND d."clearedAt" IS NULL))
 UNION ALL
 SELECT 'MEMBERS', 'MEMBER', d.id, d."firstName" || ' ' || d."lastName", CASE WHEN d.position = 'DISPATCHER' THEN 'Dispatcher, left' WHEN d."supportType" = 'UPDATER' THEN 'Updater, left' ELSE 'Support, left' END,
  'Staff record and its files', CASE WHEN coalesce(e."leftDateKnown", true) THEN 'Last day' ELSE 'Recorded as left' END, ${eastern('d."leftAt"')}, (${eastern('d."leftAt"')} + interval '3 years')::date
 FROM dispatch_members d LEFT JOIN existing_member_records e ON e."memberId" = d.id
 WHERE d.status = 'LEFT' AND d."leftAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dispatch_members n WHERE n."previousMemberId" = d.id)`;

/** The candidates with their open hold, for a day ($1, US Eastern). A hold that ran out no longer holds. */
export const WITH_HOLDS_SQL = `SELECT c.kind, c.subject, c.id, c.name, c.detail, c.what, c.basis, c."basisOn"::text AS "basisOn", c."dueOn"::text AS "dueOn", h.id AS "holdId", to_char(h.until, 'YYYY-MM-DD') AS "heldUntil", h.reason AS "holdReason"
 FROM (${CANDIDATES_SQL}) c LEFT JOIN retention_holds h ON h."subjectKind" = c.subject AND h."subjectId" = c.id AND h."endedAt" IS NULL AND h.until >= $1::date`;
