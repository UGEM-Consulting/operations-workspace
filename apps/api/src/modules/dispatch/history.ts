import type { EntityManager } from 'typeorm';
import { usDay } from '../safety/screening-rules';
import { WITH_LEAVING_MS } from './bring-back';

/**
 * The complete dispatcher History (section 38: HistoryTimelineScreen and the screens with it; approved 2026-11-19). One
 * timeline of every change to a dispatcher, support or updater: what happened, who did it and when, worded here so the
 * page only shows and filters. Tables that keep their own history (MC and team periods, support links, leave, notices,
 * seats, accounts, sharing, IT requests) are read directly; dispatch_events fill in what only they hold. Entries name the
 * field or the account, never an email, phone number, sign-in, Telegram or legal name; reasons staff wrote show as written.
 */
export type HistoryCategory = 'WORK' | 'ACCOUNTS' | 'AWAY' | 'DETAILS' | 'IT' | 'VIEWS';
/** dateOnly: a day picked in a form (stored at midday UTC), shown as a date with no time. */
export interface HistoryEntry { id: string; at: string; category: HistoryCategory; icon: string; title: string; by: string | null; body: string | null; dateOnly?: boolean }
/** Days picked in forms are stored at midday UTC; nothing recorded by a click lands on it to the millisecond. */
const DAY_ONLY = /T12:00:00\.\d{3}Z$/;
/** A day sorts after what was clicked that day (US Eastern), since it's usually recorded later the same day or for an earlier one. */
const sortKey = (entry: HistoryEntry) => entry.dateOnly ? easternDayEnd(entry.at.slice(0, 10)) : entry.at;
/** The last moment of a day in US Eastern time (EST or EDT, whichever applies that day), as an ISO string. */
function easternDayEnd(day: string) {
 const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(new Date(`${day}T12:00:00Z`)).find(part => part.type === 'timeZoneName')?.value.replace('GMT', '') || '-05:00';
 return new Date(`${day}T23:59:59.999${offset}`).toISOString();
}
type Q = Pick<EntityManager, 'query'>;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Who did it, as staff read it: their name, with (IT) or (team lead) when that's who it was.
const actor = (u: string) => `CASE WHEN ${u}.id IS NULL THEN NULL ELSE ${u}."firstName" || ' ' || ${u}."lastName" || CASE ${u}.role WHEN 'IT_SPECIALIST' THEN ' (IT)' WHEN 'TEAM_LEAD' THEN ' (team lead)' ELSE '' END END`;
const person = (d: string) => `CASE WHEN ${d}.id IS NULL THEN NULL ELSE ${d}."firstName" || ' ' || ${d}."lastName" END`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A calendar day (YYYY-MM-DD) as "Nov 14, 2026". */
const day = (value: string | null | undefined) => { if (!value) return 'a day not recorded'; const [y, m, d] = value.slice(0, 10).split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const iso = (value: Date | string) => new Date(value).toISOString();
const near = (a: Date | string | null, b: Date | string | null, ms = 2000) => !!a && !!b && Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= ms;
const kindWords = (kind: string) => kind === 'EMAIL' ? 'company email' : 'RingCentral number';
const list = (words: string[]) => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
const sentence = (words: string[]) => { const text = words.join(', '); return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : null; };

// Field names on recorded-details changes and corrections.
const FIELD_WORDS: Record<string, string> = { companyEmail: 'company email', ringCentralNumber: 'RingCentral number', ringCentralExtension: 'extension', personalEmail: 'personal email', personalPhone: 'personal phone',
 personalPhoneNumber: 'personal phone', telegram: 'Telegram', datEmail: 'DAT sign-in', truckstopEmail: 'Truckstop sign-in', NDA: 'paper NDA date', SOP: 'paper SOP date', legalName: 'legal name', lastDay: 'last day',
 leftReason: 'reason for leaving', otherNames: 'other names', companyAccount: 'an account at another company', seats: 'load board seats', sharedEmail: 'shared company email', sharedNumber: 'shared RingCentral number',
 legalFirstName: 'legal first name', legalLastName: 'legal last name', preferredAmericanFirstName: 'American first name', preferredAmericanLastName: 'American last name', firstName: 'first name', lastName: 'last name',
 nameUsed: 'name used there', note: 'note', position: 'position there' };
const words = (fields: string[]) => fields.map(field => FIELD_WORDS[field] ?? field);
// Onboarding steps worth reading; sends, failures and drafts stay out, and IT's own entries come from its requests.
const ACTIVITY: Record<string, string | null> = { INVITATION_CREATED: 'Invitation created', INVITATION_CLAIMED: 'Invitation opened', APPLICANT_VERIFIED: 'Email verified', APPLICATION_SUBMITTED: 'Application sent',
 APPLICATION_RESUBMITTED: 'Corrections sent', APPLICATION_CHANGES_REQUESTED: 'Changes asked for', APPLICATION_APPROVED: 'Application approved', APPLICATION_REJECTED: 'Application rejected', EMPLOYMENT_CONFIRMED: 'Employment confirmed',
 NDA_COUNTERSIGNED: 'NDA countersigned', INVITATION_REVOKED: 'Link revoked', ACCESS_EXTENDED: 'More time given', MANAGER_CHANGED: 'Responsible manager changed', DRAFT_SAVED: null, VERIFICATION_EMAIL_SENT: null,
 VERIFICATION_EMAIL_FAILED: null, CODE_NOT_SENT_DAILY_LIMIT: null, CODE_NOT_SENT_ACCESS_ENDED: null, CODE_LIMIT_RESET: null, INVITATION_ADDRESS_LIMIT: null, IT_REQUEST_CREATED: null, IT_ONBOARDING_COMPLETED: null };
const activityTitle = (event: string) => event in ACTIVITY ? ACTIVITY[event] : `${event.charAt(0)}${event.slice(1).toLowerCase().replace(/_/g, ' ')}`;
const IT_ITEMS: Record<string, string> = { GOOGLE_WORKSPACE: 'company email', RINGCENTRAL: 'RingCentral number', SMS: 'texting', CALL_RECORDING: 'call recording', BUSINESS_SOFTWARE: 'business software', EQUIPMENT: 'equipment' };

/** Every history entry for one person, newest first, and how many each filter has (views counted apart). */
export async function memberHistory(db: Q, memberId: string): Promise<{ entries: HistoryEntry[]; counts: Record<'ALL' | HistoryCategory, number> }> {
 const [member]: Row[] = await db.query(`SELECT d.id, d.position, d.status, d."applicationId", d."accountUserId", d."leftReason", d."leftAt" FROM dispatch_members d WHERE d.id = $1`, [memberId]);
 if (!member) return { entries: [], counts: { ALL: 0, WORK: 0, ACCOUNTS: 0, AWAY: 0, DETAILS: 0, IT: 0, VIEWS: 0 } };
 const out: HistoryEntry[] = [];
 const add = (id: string, at: Date | string | null, category: HistoryCategory, icon: string, title: string, by: string | null = null, body: string | null = null) => { if (!at || !title) return; const when = iso(at); out.push({ id, at: when, category, icon, title, by, body, ...(DAY_ONLY.test(when) ? { dateOnly: true } : {}) }); };
 // A few queries at a time, so one page never takes the whole connection pool (max 10) from other requests.
 const running = new Set<Promise<unknown>>();
 const q = async (sql: string, params: unknown[] = [memberId]): Promise<Row[]> => {
  while (running.size >= 4) await Promise.race(running);
  const query = db.query(sql, params) as Promise<Row[]>;
  const done = query.then(() => undefined, () => undefined).finally(() => running.delete(done));
  running.add(done); return query;
 };

 const [record] = await q(`SELECT "periodDateKnown" FROM existing_member_records WHERE "memberId" = $1`);
 const [assignments, events, links, helpers, promotions, asked, drivers, notices, removals, leaves, leaveIt, contacts, corrections, startDates, scans, photos, accounts, seats, shared, ownedBy, ownerChanges, setups, accountRequests, signIns, activity, returns] = await Promise.all([
  q(`SELECT a.id, a."startedAt", a."endedAt", a.reason, m.name AS mc, t.name AS team, ${actor('u')} AS by FROM member_assignments a LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN teams t ON t.id = a."teamId" LEFT JOIN users u ON u.id = a."actorId"
   WHERE a."memberId" = $1 ORDER BY a."startedAt", a."createdAt"`),
  q(`SELECT e.id, e.event, e.metadata, e."createdAt", ${actor('u')} AS by, t.name AS team, jt.name AS "jobTitle", ${person('o')} AS owner, ${person('p')} AS "previousOwner", ${person('x')} AS "toPerson",
    coalesce(cm.name, ca."companyName") AS company, la.name AS "seatAccount"
   FROM dispatch_events e LEFT JOIN users u ON u.id = e."actorId" LEFT JOIN teams t ON t.id = e."teamId"
   LEFT JOIN job_titles jt ON jt.id::text = e.metadata->>'to' AND e.event = 'MEMBER_UPDATED'
   LEFT JOIN dispatch_members o ON o.id::text = e.metadata->>'ownerId' LEFT JOIN dispatch_members p ON p.id::text = e.metadata->>'previousOwnerId'
   LEFT JOIN dispatch_members x ON x.id::text = e.metadata->>'to' AND e.event IN ('ACCOUNT_MOVED','ACCOUNTS_HANDED_OVER')
   LEFT JOIN member_company_accounts ca ON ca.id::text = e.metadata->>'accountId' LEFT JOIN mcs cm ON cm.id = ca."mcId"
   LEFT JOIN member_load_board_seats ls ON ls.id::text = e.metadata->>'seatId' LEFT JOIN load_board_accounts la ON la.id = ls."accountId"
   WHERE e."memberId" = $1 ORDER BY e."createdAt"`),
  // Who they helped, as a support or updater (kept after a promotion).
  q(`SELECT l.id, l."startedAt", l."endedAt", l.reason, ${person('d')} AS dispatcher, t.name AS team, ${actor('u')} AS by FROM member_support_links l LEFT JOIN dispatch_members d ON d.id = l."dispatcherId"
   LEFT JOIN teams t ON t.id = l."teamId" LEFT JOIN users u ON u.id = l."actorId" WHERE l."supportId" = $1 ORDER BY l."startedAt", l."createdAt"`),
  // Who helped them, as a dispatcher.
  q(`SELECT l.id, l."startedAt", l."endedAt", l.reason, ${person('s')} AS support, ${actor('u')} AS by FROM member_support_links l JOIN dispatch_members s ON s.id = l."supportId" LEFT JOIN users u ON u.id = l."actorId"
   WHERE l."dispatcherId" = $1 ORDER BY l."startedAt"`),
  q(`SELECT r.id, r.status, r."createdAt", r."decidedAt", r."updatedAt", r.note, ${actor('rq')} AS "requestedBy", ${actor('dc')} AS "decidedBy" FROM promotion_requests r
   LEFT JOIN users rq ON rq.id = r."requestedBy" LEFT JOIN users dc ON dc.id = r."decidedBy" WHERE r."supportId" = $1 ORDER BY r."createdAt"`),
  // A team lead's own requests to promote someone.
  member.accountUserId ? q(`SELECT r.id, r."createdAt", ${person('s')} AS support FROM promotion_requests r JOIN dispatch_members s ON s.id = r."supportId" WHERE r."requestedBy" = $1`, [member.accountUserId]) : [],
  q(`SELECT a.id, a."startedAt", a."endedAt", a.reason, ${person('dr')} AS driver, ${actor('u')} AS by, c.id AS "coverId", ${person('away')} AS "awayFrom",
    (SELECT json_build_object('memberId', n."memberId", 'name', ${person('nd')}, 'by', ${actor('nu')}) FROM driver_assignments n LEFT JOIN dispatch_members nd ON nd.id = n."memberId" LEFT JOIN users nu ON nu.id = n."actorId"
     WHERE n."driverId" = a."driverId" AND n."startedAt" >= a."endedAt" - interval '1 second' AND n.id <> a.id ORDER BY n."startedAt" LIMIT 1) AS next
   FROM driver_assignments a JOIN drivers dr ON dr.id = a."driverId" LEFT JOIN users u ON u.id = a."actorId"
   LEFT JOIN driver_leave_covers c ON c."coverAssignmentId" = a.id LEFT JOIN member_leaves ml ON ml.id = c."leaveId" LEFT JOIN dispatch_members away ON away.id = ml."memberId"
   WHERE a."memberId" = $1 ORDER BY a."startedAt"`),
  q(`SELECT n.id, n."lastDay"::text AS "lastDay", n.reason, n.changes, n."createdAt", n."cancelledAt", n."cancelReason", ${actor('r')} AS by, ${actor('c')} AS "cancelledBy"
   FROM member_notices n LEFT JOIN users r ON r.id = n."recordedBy" LEFT JOIN users c ON c.id = n."cancelledBy" WHERE n."memberId" = $1`),
  q(`SELECT r.id, r."dueOn"::text AS "dueOn", r."createdAt", r."completedAt", r."cancelledAt", r."reversedAt", r."removeNowAt", r."removeNowReason", ${actor('u')} AS by FROM it_removal_requests r LEFT JOIN users u ON u.id = r."createdBy" WHERE r."memberId" = $1`),
  q(`SELECT l.id, l."firstDay"::text AS "firstDay", l."backOn"::text AS "backOn", l.reason, l.changes, l."startedAt", l."endedAt", l."endedHow", l."createdAt", ${actor('r')} AS by, ${actor('e')} AS "endedBy"
   FROM member_leaves l LEFT JOIN users r ON r.id = l."recordedBy" LEFT JOIN users e ON e.id = l."endedBy" WHERE l."memberId" = $1`),
  q(`SELECT q.id, q.kind, q."createdAt", q."completedAt", q."cancelledAt" FROM it_leave_requests q WHERE q."memberId" = $1`),
  q(`SELECT c.id, c.kind, c."createdAt", c."removedAt", ${actor('a')} AS by, ${actor('r')} AS "removedBy" FROM member_contacts c LEFT JOIN users a ON a.id = c."addedBy" LEFT JOIN users r ON r.id = c."removedBy" WHERE c."memberId" = $1`),
  q(`SELECT c.id, c.changes, c.reason, c."createdAt", ${actor('u')} AS by FROM member_detail_corrections c LEFT JOIN users u ON u.id = c."actorId" WHERE c."memberId" = $1`),
  q(`SELECT s.id, s."startedOn"::text AS "startedOn", s."previousOn"::text AS "previousOn", s.reason, s."createdAt", ${actor('u')} AS by,
    (SELECT (e.metadata->>'periodMoved')::boolean FROM dispatch_events e WHERE e."memberId" = s."memberId" AND e.event = 'START_DATE_RECORDED' AND abs(extract(epoch FROM e."createdAt" - s."createdAt")) < 5 LIMIT 1) AS "periodMoved"
   FROM member_start_date_changes s LEFT JOIN users u ON u.id = s."actorId" WHERE s."memberId" = $1`),
  q(`SELECT s.id, s.kind, s."pageCount", s."createdAt", ${actor('u')} AS by FROM member_paper_scans s LEFT JOIN users u ON u.id = s."uploadedBy" WHERE s."memberId" = $1 ORDER BY s."createdAt"`),
  q(`SELECT p.id, p.kind, p."createdAt", ${actor('u')} AS by FROM member_photos p LEFT JOIN users u ON u.id = p."uploadedBy" WHERE p."memberId" = $1 ORDER BY p."createdAt"`),
  q(`SELECT a.id, coalesce(m.name, a."companyName") AS company, a.status, a."companyEmail" IS NOT NULL AS email, a."ringCentralNumber" IS NOT NULL AS number, a."createdAt", a."closedAt", a."sourceName",
    ${actor('c')} AS by, ${actor('x')} AS "closedBy" FROM member_company_accounts a LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN users c ON c.id = a."createdBy" LEFT JOIN users x ON x.id = a."closedBy" WHERE a."memberId" = $1`),
  q(`SELECT s.id, s."startedAt", s."endedAt", s."endedHow", s."createdAt", a.name AS account, ${actor('c')} AS by, ${actor('e')} AS "endedBy" FROM member_load_board_seats s JOIN load_board_accounts a ON a.id = s."accountId"
   LEFT JOIN users c ON c.id = s."createdBy" LEFT JOIN users e ON e.id = s."endedBy" WHERE s."memberId" = $1 ORDER BY s."startedAt", s."createdAt"`),
  q(`SELECT s.id, s.kind, s."createdAt", s."handedOverAt", s."endedAt", s."endedHow", ${person('o')} AS owner, ${actor('c')} AS by, ${actor('e')} AS "endedBy" FROM member_shared_accounts s
   LEFT JOIN dispatch_members o ON o.id = s."ownerMemberId" LEFT JOIN users c ON c.id = s."createdBy" LEFT JOIN users e ON e.id = s."endedBy" WHERE s."memberId" = $1`),
  // Others using what they own.
  q(`SELECT s.id, s.kind, s."createdAt", s."endedAt", s."endedHow", s."handedOverAt", ${person('d')} AS "user", ${actor('c')} AS by, ${actor('e')} AS "endedBy" FROM member_shared_accounts s JOIN dispatch_members d ON d.id = s."memberId"
   LEFT JOIN users c ON c.id = s."createdBy" LEFT JOIN users e ON e.id = s."endedBy" WHERE s."ownerMemberId" = $1 AND s."memberId" <> $1`),
  // Someone else's use of an email or number that changed owner to or from them: the change, and the shared row it was about.
  q(`SELECT e.id, e.metadata, e."createdAt", ${actor('u')} AS by, ${person('d')} AS "user", ${person('p')} AS "previousOwner", s.id AS "rowId", s."createdAt" AS "rowCreatedAt", ${actor('c')} AS "rowBy"
   FROM (SELECT id FROM dispatch_events WHERE event = 'SHARED_OWNER_CHANGED' AND metadata->>'ownerId' = $1::text
    UNION SELECT id FROM dispatch_events WHERE event = 'SHARED_OWNER_CHANGED' AND metadata->>'previousOwnerId' = $1::text) mine JOIN dispatch_events e ON e.id = mine.id
   JOIN dispatch_members d ON d.id = e."memberId" LEFT JOIN dispatch_members p ON p.id::text = e.metadata->>'previousOwnerId' LEFT JOIN users u ON u.id = e."actorId"
   LEFT JOIN LATERAL (SELECT r.id, r."createdAt", r."createdBy" FROM member_shared_accounts r WHERE r."memberId" = e."memberId" AND r.kind = e.metadata->>'kind' AND r."createdAt" <= e."createdAt"
    ORDER BY r."createdAt" DESC LIMIT 1) s ON true LEFT JOIN users c ON c.id = s."createdBy" ORDER BY e."createdAt"`),
  // Two index lookups (by application, and by member), never an OR.
  q(`SELECT r.id, r.purpose, r."createdAt", r."completedAt", r."cancelledAt", ${actor('u')} AS by, coalesce(array_agg(t.key) FILTER (WHERE t.id IS NOT NULL), '{}') AS tasks
   FROM (SELECT id FROM it_onboarding_requests WHERE "applicationId" = $2::uuid UNION SELECT id FROM it_onboarding_requests WHERE "memberId" = $1) mine JOIN it_onboarding_requests r ON r.id = mine.id
   LEFT JOIN users u ON u.id = r."requestedBy" LEFT JOIN it_onboarding_tasks t ON t."requestId" = r.id GROUP BY r.id, u.id`, [memberId, member.applicationId]),
  q(`SELECT r.id, r.kind, r."createdAt", r."completedAt", r."cancelledAt", r.note, r.profile->>'toMc' AS "toMc", coalesce(m.name, a."companyName") AS company FROM it_account_requests r
   LEFT JOIN member_company_accounts a ON a.id = r."accountId" LEFT JOIN mcs m ON m.id = a."mcId" WHERE r."memberId" = $1`),
  q(`SELECT s.id, s.kind, s."doneAt", ${actor('u')} AS by FROM team_lead_sign_ins s LEFT JOIN users u ON u.id = s."doneBy" WHERE s."memberId" = $1 AND s."doneAt" IS NOT NULL`),
  // Onboarding: the approved application's invitation, and catch-up links for someone added by hand.
  q(`SELECT a.id, a.event, a."createdAt", ${actor('u')} AS by FROM application_activity a LEFT JOIN users u ON u.id = a."actorId"
   WHERE a."invitationId" IN (SELECT ap."invitationId" FROM dispatcher_applications ap WHERE ap.id = $2 UNION SELECT i.id FROM invitations i WHERE i."catchUpMemberId" = $1)`, [memberId, member.applicationId]),
  q(`SELECT r.id, r.kind, r."leftReason", r."firstDay"::text AS "firstDay", r.reason, r."createdAt", ${actor('u')} AS by FROM member_returns r LEFT JOIN users u ON u.id = r."actorId" WHERE r."memberId" = $1 ORDER BY r."createdAt"`),
 ]);
 // Notice changes keep who made them by id only.
 const changers = [...new Set(notices.flatMap(row => ((row.changes ?? []) as Row[]).map(change => change.by as string).filter(Boolean)))];
 const changerNames = new Map((changers.length ? await q(`SELECT u.id, ${actor('u')} AS name FROM users u WHERE u.id = ANY($1::uuid[])`, [changers]) : []).map(row => [row.id as string, row.name as string]));
 // A period with no date of its own holds the day they were added, so it never reads as the day they started (section 34).
 const firstPeriod = record && !record.periodDateKnown ? [...assignments, ...links].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())[0]?.id : null;
 const undated = (row: Row) => row.id === firstPeriod ? ' (start date not recorded)' : '';

 // Work: MC and team, job title, team lead, support or updater, who they help, drivers, promotion.
 // A rehire's first day starts again even when it's the day after they left, which the gap alone can't tell from a move.
 const rehireDays = new Set(returns.filter(row => row.kind === 'REHIRE').map(row => row.firstDay as string));
 assignments.forEach((row, index) => {
  const place = row.team ? `${row.team} at ${row.mc}` : row.mc ? `${row.mc}, independent` : 'no MC yet';
  // A period after time away (a rehire, section 41) starts again rather than moving.
  const previous = assignments[index - 1], startDay = new Date(row.startedAt).toISOString().slice(0, 10);
  // Only the period that ends the time away: a move later that same day ended a period that began that day.
  const again = !!previous?.endedAt && (new Date(row.startedAt).getTime() - new Date(previous.endedAt).getTime() > WITH_LEAVING_MS || (rehireDays.has(startDay) && new Date(previous.endedAt).toISOString().slice(0, 10) < startDay));
  add(`assignment-${row.id}`, row.startedAt, 'WORK', 'route', index === 0 ? `Started in ${place}${undated(row)}` : again ? `Started again in ${place}` : `Moved to ${place}`, row.by, row.reason ?? null);
 });
 links.forEach((row, index) => {
  const who = row.team ? `the whole ${row.team}` : row.dispatcher ?? 'a dispatcher no longer recorded';
  add(`link-${row.id}`, row.startedAt, 'WORK', 'headset', `${row.team ? `Now helps ${who}` : `Started helping ${who}`}${undated(row)}`, row.by, row.reason ?? null);
  // A reassignment ends one link as the next one starts: that reads as the new one only. Leaving says it on its own.
  const next = links[index + 1];
  if (row.endedAt && !near(row.endedAt, next?.startedAt, 60000) && !near(row.endedAt, member.leftAt, 60000)) add(`link-end-${row.id}`, row.endedAt, 'WORK', 'headset', `Stopped helping ${who}`);
 });
 for (const row of helpers) {
  add(`helper-${row.id}`, row.startedAt, 'WORK', 'headset', `${row.support} started helping them`, row.by, row.reason ?? null);
  if (row.endedAt) add(`helper-end-${row.id}`, row.endedAt, 'WORK', 'headset', `${row.support} stopped helping them`);
 }
 for (const row of promotions) {
  add(`promotion-${row.id}`, row.createdAt, 'WORK', 'trending-up', row.requestedBy ? `Promotion asked by ${row.requestedBy}` : 'Promotion asked');
  if (row.status === 'APPROVED') add(`promotion-done-${row.id}`, row.decidedAt, 'WORK', 'trending-up', 'Promoted to dispatcher', row.decidedBy);
  if (row.status === 'DECLINED') add(`promotion-done-${row.id}`, row.decidedAt, 'WORK', 'trending-up', 'Promotion declined', row.decidedBy, row.note ?? null);
  if (row.status === 'CANCELLED') add(`promotion-done-${row.id}`, row.decidedAt ?? row.updatedAt, 'WORK', 'trending-up', 'Promotion request cancelled', row.decidedBy);
 }
 for (const row of asked) add(`asked-${row.id}`, row.createdAt, 'WORK', 'trending-up', `Asked to promote ${row.support}`);
 for (const row of drivers) {
  add(`driver-${row.id}`, row.startedAt, 'WORK', 'truck', row.coverId ? `Covering driver ${row.driver} while ${row.awayFrom ?? 'their dispatcher'} is away` : `Driver ${row.driver} assigned`, row.by, row.coverId ? null : row.reason ?? null);
  if (!row.endedAt) continue;
  if (row.next && row.next.memberId !== memberId) add(`driver-end-${row.id}`, row.endedAt, 'WORK', 'truck', `Driver ${row.driver} moved to ${row.next.name ?? 'another dispatcher'}`, row.next.by);
  else if (!row.next) add(`driver-end-${row.id}`, row.endedAt, 'WORK', 'truck', `Driver ${row.driver} no longer assigned`);
 }

 // Leave and leaving: notices, access removal, leaving; leave and who covers.
 for (const row of notices) {
  // The last day as given: a change keeps the day it replaced, so the first one's from is the original.
  add(`notice-${row.id}`, row.createdAt, 'AWAY', 'calendar', `Notice given: last day ${day(row.changes?.[0]?.from ?? row.lastDay)}`, row.by, row.reason);
  (row.changes ?? []).forEach((change: Row, index: number) => add(`notice-change-${row.id}-${index}`, change.at, 'AWAY', 'calendar', `Last day changed to ${day(change.to)}`, changerNames.get(change.by) ?? null, change.reason ?? null));
  if (row.cancelledAt) add(`notice-cancel-${row.id}`, row.cancelledAt, 'AWAY', 'calendar', 'Notice cancelled', row.cancelledBy, row.cancelReason ?? null);
 }
 for (const row of leaves) {
  add(`leave-${row.id}`, row.createdAt, 'AWAY', 'calendar-clock', `Leave recorded: ${day(row.firstDay)} to ${day(row.backOn)}`, row.by, row.reason);
  // Leave put in place for today starts with it; a later first day is the leave job's.
  if (row.startedAt) add(`leave-start-${row.id}`, row.startedAt, 'AWAY', 'calendar-clock', 'Leave started', near(row.startedAt, row.createdAt, 60000) ? row.by : 'Leave job');
  (row.changes ?? []).forEach((change: Row, index: number) => add(`leave-change-${row.id}-${index}`, change.at, 'AWAY', 'calendar-clock',
   change.kind === 'BACK_ON' ? `Return date changed to ${day(change.to)}` : 'Leave reason changed', change.byName ?? null, change.kind === 'BACK_ON' ? change.reason ?? null : change.to ?? null));
  if (row.endedAt) add(`leave-end-${row.id}`, row.endedAt, 'AWAY', 'calendar-clock', row.endedHow === 'CANCELLED' ? 'Leave cancelled' : row.endedHow === 'LEAVING' ? 'Leave ended: they’re leaving' : 'Back from leave', row.endedBy ?? 'Leave job');
 }

 // Details: contacts, corrections, start date, scans and photos.
 for (const row of contacts) {
  const what = row.kind === 'EMAIL' ? 'Email' : 'Phone number';
  add(`contact-${row.id}`, row.createdAt, 'DETAILS', row.kind === 'EMAIL' ? 'mail' : 'phone', `${what} added`, row.by);
  if (row.removedAt) add(`contact-removed-${row.id}`, row.removedAt, 'DETAILS', row.kind === 'EMAIL' ? 'mail' : 'phone', `${what} removed`, row.removedBy);
 }
 for (const row of corrections) add(`correction-${row.id}`, row.createdAt, 'DETAILS', 'pen-line', `Details corrected: ${list(words((row.changes ?? []).map((change: Row) => change.field)))}`, row.by, row.reason ?? null);
 for (const row of startDates) add(`start-${row.id}`, row.createdAt, 'DETAILS', 'calendar', `Start date ${row.previousOn ? 'corrected' : 'added'}: ${day(row.startedOn)}${row.periodMoved ? '. The first MC and team period moved with it' : ''}`, row.by, row.reason ?? null);
 const seenScan = new Set<string>(), seenPhoto = new Set<string>();
 for (const row of scans) { add(`scan-${row.id}`, row.createdAt, 'DETAILS', 'file-text', `${row.kind} paper scan ${seenScan.has(row.kind) ? 'replaced' : 'added'} (${row.pageCount} ${row.pageCount === 1 ? 'page' : 'pages'})`, row.by); seenScan.add(row.kind); }
 for (const row of photos) { add(`photo-${row.id}`, row.createdAt, 'DETAILS', 'image', `${row.kind === 'ID' ? 'ID photo' : 'Profile photo'} ${seenPhoto.has(row.kind) ? 'replaced' : 'added'}`, row.by); seenPhoto.add(row.kind); }
 for (const row of activity) { const title = activityTitle(row.event); if (title) add(`activity-${row.id}`, row.createdAt, 'DETAILS', 'user-check', title, row.by); }

 // Accounts: other companies, load board seats, shared email or number.
 for (const row of accounts) {
  const what = [row.email ? 'company email' : null, row.number ? 'RingCentral number' : null].filter(Boolean) as string[];
  const createdClosed = row.status === 'CLOSED' && near(row.closedAt, row.createdAt, 5000);
  add(`account-${row.id}`, row.createdAt, 'ACCOUNTS', 'building-2', `Account at ${row.company} added: ${list(what)}${createdClosed ? ' (closed)' : row.status === 'KEPT_FOR_LOAD_BOARDS' ? ' (kept for load boards)' : ''}`,
   row.sourceName ? `From ${row.sourceName}` : row.by);
  if (row.closedAt && !createdClosed) add(`account-closed-${row.id}`, row.closedAt, 'ACCOUNTS', 'building-2', `Account at ${row.company} closed`, row.closedBy);
 }
 seats.forEach(row => {
  const movedInto = seats.some(other => other.id !== row.id && other.endedHow === 'MOVED' && near(other.endedAt, row.startedAt, 5000));
  if (!movedInto) add(`seat-${row.id}`, row.startedAt, 'ACCOUNTS', 'layers', `Seat on ${row.account} added`, row.by ?? 'From their recorded sign-in');
  if (!row.endedAt) return;
  const into = row.endedHow === 'MOVED' ? seats.find(other => other.id !== row.id && near(row.endedAt, other.startedAt, 5000)) : null;
  add(`seat-end-${row.id}`, row.endedAt, 'ACCOUNTS', 'layers', row.endedHow === 'MOVED' ? `Seat on ${row.account} moved to ${into?.account ?? 'another account'}` : row.endedHow === 'LEFT' ? `Seat on ${row.account} ended when IT removed access` : `Seat on ${row.account} ended`,
   row.endedHow === 'LEFT' ? 'IT removal' : row.endedBy);
 });
 for (const row of shared) {
  // The owner changes in place when it moves or is handed over; the first SHARED_OWNER_CHANGED since names who it was then.
  const firstChange = events.find(event => event.event === 'SHARED_OWNER_CHANGED' && event.metadata?.kind === row.kind && new Date(event.createdAt) >= new Date(row.createdAt)
   && (!row.endedAt || new Date(event.createdAt) <= new Date(row.endedAt)));
  const what = `${(firstChange ? firstChange.previousOwner : row.owner) ?? 'someone'}’s ${kindWords(row.kind)}`;
  if (!row.handedOverAt || !near(row.handedOverAt, row.createdAt, 5000)) add(`shared-${row.id}`, row.createdAt, 'ACCOUNTS', 'users', `Started using ${what} (shared)`, row.by);
  if (row.handedOverAt) add(`shared-owner-${row.id}`, row.handedOverAt, 'ACCOUNTS', 'users', `Now owns ${what} (handed over when ${row.owner ?? 'its owner'} left)`, row.by);
  if (row.endedAt && row.endedHow !== 'LEFT') add(`shared-end-${row.id}`, row.endedAt, 'ACCOUNTS', 'users', row.endedHow === 'OWNER_LEFT' ? `Stopped using ${what}: ${row.owner ?? 'its owner'} left` : row.endedHow === 'MOVED' ? `The ${kindWords(row.kind)} they used is now theirs` : `Stopped using ${what}`, row.endedBy);
 }
 // Rows that became theirs start when they did; rows they gave up still started with them, when they were the first owner.
 const becameMine = ownerChanges.filter(row => row.metadata?.ownerId === memberId), gaveUp = ownerChanges.filter(row => row.metadata?.previousOwnerId === memberId);
 for (const row of becameMine) add(`owner-change-${row.id}`, row.createdAt, 'ACCOUNTS', 'users', `${row.user} now uses their ${kindWords(row.metadata.kind)}`, row.by,
  row.metadata.why === 'handed-over' ? `Handed over when ${row.previousOwner ?? 'its owner'} left.` : `Moved from ${row.previousOwner ?? 'another record'}.`);
 for (const row of gaveUp) {
  if (!row.rowId || becameMine.some(other => other.rowId === row.rowId && new Date(other.createdAt) <= new Date(row.createdAt))) continue;
  add(`owned-${row.rowId}`, row.rowCreatedAt, 'ACCOUNTS', 'users', `${row.user} started using their ${kindWords(row.metadata.kind)}`, row.rowBy);
 }
 for (const row of ownedBy) {
  if (!row.handedOverAt && !becameMine.some(change => change.rowId === row.id)) add(`owned-${row.id}`, row.createdAt, 'ACCOUNTS', 'users', `${row.user} started using their ${kindWords(row.kind)}`, row.by);
  if (row.endedAt && row.endedHow === 'STOPPED') add(`owned-end-${row.id}`, row.endedAt, 'ACCOUNTS', 'users', `${row.user} stopped using their ${kindWords(row.kind)}`, row.endedBy);
 }

 // Coming back (section 41): each undone leaving and rehire, with why a leaving was undone.
 for (const row of returns) {
  if (row.kind === 'UNDO') add(`return-${row.id}`, row.createdAt, 'AWAY', 'undo-2', 'Leaving undone', row.by, row.reason);
  else add(`return-${row.id}`, row.createdAt, 'WORK', 'user-plus', `Rehired, back ${day(row.firstDay)}`, row.by);
 }
 // IT: setups, removals, leave suspend and restore, account requests, sign-ins. A promotion starts the dispatcher setup in its decision.
 const promotion = (at: Date) => promotions.find(row => row.status === 'APPROVED' && near(row.decidedAt, at, 60000));
 for (const row of setups) {
  const items = list((row.tasks as string[]).map(key => IT_ITEMS[key]).filter((value, index, all) => value && all.indexOf(value) === index));
  const asked = row.purpose !== 'DISPATCHER', promoted = asked ? null : promotion(row.createdAt);
  const title = row.purpose === 'RESTORE' ? `IT asked to restore their access: ${items || 'the Dispatch group'}` : row.purpose === 'REHIRE' ? `IT setup asked for their return: ${items || 'the Dispatch group'}`
   : row.purpose === 'SUPPORT' ? `IT setup asked: ${items}` : promoted ? 'IT setup started for their promotion' : 'IT setup started';
  add(`setup-${row.id}`, row.createdAt, 'IT', 'monitor', title, row.by ?? (asked ? null : promoted ? promoted.decidedBy : 'Approval'));
  if (row.completedAt) add(`setup-done-${row.id}`, row.completedAt, 'IT', 'monitor', 'IT finished setting up their accounts');
  if (row.cancelledAt) add(`setup-cancel-${row.id}`, row.cancelledAt, 'IT', 'monitor', 'IT setup stopped');
 }
 // The day a removal was scheduled for: the last day of the notice recorded with it, as given (a later change or Remove access
 // now moves dueOn, and has its own entry); without a notice, its due date.
 const scheduledFor = (removal: Row) => {
  const notice = notices.find(row => near(row.createdAt, removal.createdAt, 10000));
  return notice ? notice.changes?.[0]?.from ?? notice.lastDay : removal.dueOn;
 };
 for (const row of removals) {
  add(`removal-${row.id}`, row.createdAt, 'IT', 'monitor', row.dueOn && row.dueOn > usDay('latest', new Date(row.createdAt)) ? `IT removal scheduled for ${day(scheduledFor(row))}` : 'IT asked to remove access', row.by);
  if (row.completedAt) add(`removal-done-${row.id}`, row.completedAt, 'IT', 'monitor', 'IT finished removing access');
  if (row.cancelledAt) add(`removal-cancel-${row.id}`, row.cancelledAt, 'IT', 'monitor', row.reversedAt ? 'IT’s removal reversed: they came back' : 'IT removal cancelled');
 }
 for (const row of leaveIt) {
  const suspend = row.kind === 'SUSPEND';
  add(`leave-it-${row.id}`, row.createdAt, 'IT', 'monitor', suspend ? 'IT asked to suspend their accounts for the leave' : 'IT asked to restore their accounts');
  if (row.completedAt) add(`leave-it-done-${row.id}`, row.completedAt, 'IT', 'monitor', suspend ? 'IT suspended their accounts for the leave' : 'IT restored their accounts');
 }
 for (const row of accountRequests) {
  const close = row.kind === 'CLOSE';
  add(`account-it-${row.id}`, row.createdAt, 'IT', 'building-2', close ? `IT asked to close the account at ${row.company}` : `IT asked for accounts at ${row.toMc ?? 'the new MC'}`, null, close ? row.note ?? null : null);
  if (row.completedAt) add(`account-it-done-${row.id}`, row.completedAt, 'IT', 'building-2', close ? `IT closed the account at ${row.company}` : `IT set up their accounts at ${row.toMc ?? 'the new MC'}`);
  if (row.cancelledAt) add(`account-it-cancel-${row.id}`, row.cancelledAt, 'IT', 'building-2', 'IT request stopped');
 }
 for (const row of signIns) add(`signin-${row.id}`, row.doneAt, 'IT', 'key-round', row.kind === 'CREATE' ? 'Team lead sign-in created' : row.kind === 'TURN_ON' ? 'Team lead sign-in turned back on' : 'Team lead sign-in turned off', row.by);

 // What only events hold.
 const latestLeft = [...events].reverse().find(row => row.event === 'MEMBER_LEFT')?.id;
 const removeNowReason = (at: Date) => removals.find(row => row.removeNowAt && near(row.removeNowAt, at, 60000))?.removeNowReason ?? null;
 for (const row of events) {
  const m = row.metadata ?? {}, at = row.createdAt, id = `event-${row.id}`;
  switch (row.event) {
   // A leaving later undone or followed by a rehire keeps its reason on that return (section 41).
   case 'MEMBER_LEFT': add(id, at, 'AWAY', 'log-out', 'Left', row.by ?? 'Leaving job', returns.find(back => new Date(back.createdAt) > new Date(at))?.leftReason ?? (row.id === latestLeft ? member.leftReason ?? null : null)); break;
   case 'ACCESS_REMOVAL_REQUESTED': add(id, at, 'AWAY', 'shield-check', 'Access removal asked for today', row.by, removeNowReason(at)); break;
   case 'LEAVE_CHANGED': if ((m.fields ?? []).includes('covers')) add(id, at, 'AWAY', 'truck', 'Who covers their drivers changed', row.by); break;
   case 'MEMBER_UPDATED': if ((m.fields ?? []).includes('jobTitleId')) add(id, at, 'WORK', 'pen-line', row.jobTitle ? `Job title changed to ${row.jobTitle}` : m.to === null ? 'Job title removed' : 'Job title changed', row.by); break;
   case 'TEAM_LEAD_SET': add(id, at, 'WORK', 'crown', `Became team lead of ${row.team ?? 'a team'}`, row.by); break;
   case 'TEAM_LEAD_CLEARED': add(id, at, 'WORK', 'crown', `No longer team lead of ${row.team ?? 'a team'}${m.why === 'moved' ? ': they moved' : m.why === 'left' ? ': they left' : m.why === 'archived' ? ': the team was archived' : ''}`, row.by); break;
   case 'SUPPORT_TYPE_CHANGED': add(id, at, 'WORK', 'refresh-cw', m.to === 'UPDATER' ? 'Now called an updater' : 'Now called a support', row.by); break;
   case 'EXISTING_ADDED': add(id, at, 'DETAILS', 'user-plus', m.left ? 'Added as Left' : 'Added by hand', row.by); break;
   case 'EXISTING_UPDATED': {
    const count = m.otherNames, fields = (m.fields ?? []) as string[];
    const said = fields.map(field => field === 'otherNames' && count ? `${count} other ${count === 1 ? 'name' : 'names'}` : FIELD_WORDS[field] ?? field);
    const title = m.reason === 'team-lead-sign-in' ? 'Company email recorded for their team lead sign-in' : m.from === 'file' ? (m.source ? `Details added from ${m.source}` : 'Details added from a file') : 'Recorded details changed';
    add(id, at, 'DETAILS', 'pen-line', title, row.by, sentence(said)); break;
   }
   case 'NAMES_CHANGED': add(id, at, 'DETAILS', 'pen-line', 'Names changed', row.by); break;
   case 'LEFT_DAY_RECORDED': add(id, at, 'AWAY', 'calendar', 'Last day added', row.by, m.reasonChanged ? 'With the reason they left.' : null); break;
   case 'CLOSE_ACCOUNTS_ASKED': add(id, at, 'IT', 'monitor', 'IT asked to close their accounts', row.by, m.forward ? 'Email forwarded for 30 days.' : null); break;
   case 'CATCH_UP_LINK_CREATED': add(id, at, 'DETAILS', 'link', 'Catch-up link sent', row.by); break;
   case 'PAPERWORK_ACCEPTED': add(id, at, 'DETAILS', 'file-text', 'Paperwork accepted', row.by); break;
   case 'SEAT_CHANGED': {
    const on = row.seatAccount ?? `a ${m.provider === 'TRUCKSTOP' ? 'Truckstop' : 'DAT'} account`;
    if (m.action === 'EMAIL') add(id, at, 'ACCOUNTS', 'layers', `Sign-in changed on ${on}`, row.by);
    else if (m.action === 'SUSPEND') add(id, at, 'ACCOUNTS', 'layers', `Seat on ${on} suspended`, row.by);
    else if (m.action === 'RESUME') add(id, at, 'ACCOUNTS', 'layers', `Seat on ${on} resumed`, row.by);
    break;
   }
   case 'COMPANY_ACCOUNT_CHANGED': {
    // Closing is told by the account (and IT's request); this says what else changed.
    if (m.closeAsked || m.byIt) break;
    const said = words(((m.fields ?? []) as string[]));
    const reopened = m.status && m.status !== 'CLOSED';
    if (!said.length && !reopened) break;
    const on = `Account at ${row.company ?? 'another company'}`;
    add(id, at, 'ACCOUNTS', 'building-2', reopened && !said.length ? `${on} opened again` : `${on} changed: ${list(said)}${reopened ? ', opened again' : ''}`, row.by); break;
   }
   case 'ACCOUNT_MOVED': add(id, at, 'ACCOUNTS', 'users', `Their ${list(((m.fields ?? []) as string[]).map(field => FIELD_WORDS[field] ?? field))} moved to ${row.toPerson ?? 'the right record'}`, row.by, m.stillUses ? 'They still use it.' : null); break;
   case 'ACCOUNTS_HANDED_OVER': add(id, at, 'ACCOUNTS', 'users', `Their ${list(((m.kinds ?? []) as string[]).map(kindWords))} handed over to ${row.toPerson ?? 'someone using it'}`, row.by); break;
   case 'SHARED_OWNER_CHANGED': add(id, at, 'ACCOUNTS', 'users', `Now uses ${row.owner ?? 'someone'}’s ${kindWords(m.kind)}${m.why === 'handed-over' ? `, handed over when ${row.previousOwner ?? 'its owner'} left` : `, moved from ${row.previousOwner ?? 'another record'}`}`, row.by); break;
   case 'PAPER_SCAN_VIEWED': add(id, at, 'VIEWS', 'eye', `${m.kind ?? 'Paper'} paper scan opened${m.role ? ' (view only)' : ''}`, row.by); break;
   case 'ID_PHOTO_VIEWED': add(id, at, 'VIEWS', 'eye', 'ID photo opened', row.by); break;
   // Section 39: someone with view-only access to photos and documents opened a signed copy.
   case 'SIGNED_COPY_VIEWED': add(id, at, 'VIEWS', 'eye', `Signed ${m.kind === 'CONTACT_LIST' ? 'contact list' : m.kind ?? 'document'} opened (view only)`, row.by); break;
  }
 }
 out.sort((a, b) => sortKey(b).localeCompare(sortKey(a)) || b.id.localeCompare(a.id));
 const counts = { ALL: 0, WORK: 0, ACCOUNTS: 0, AWAY: 0, DETAILS: 0, IT: 0, VIEWS: 0 };
 for (const entry of out) { counts[entry.category] += 1; if (entry.category !== 'VIEWS') counts.ALL += 1; }
 return { entries: out, counts };
}
