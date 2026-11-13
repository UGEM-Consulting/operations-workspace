import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { User } from '../users/user.entity';
import { onboardingLimit } from '../onboarding/rate-limit';
import { usDay } from '../safety/screening-rules';
import { DispatchEvent, NO_MC } from './dispatch.entity';
import { companyEmailSql } from './lead-sign-in';
import type { MemberFilters, MemberListQueryDto, MemberViewDto } from './dispatch.dto';

/**
 * One row per dispatcher, support or updater with where they work now, as Dispatch › Dispatchers lists them. Parameters are
 * the Eastern dates (earliest and latest) that "last day passed" and IT's removal state compare with.
 */
export const memberRowsSql = (earliest = '$2', latest = '$3') => `SELECT d.id, d."firstName", d."lastName", d.position, d."supportType", d.status, d.version, d."joinedAt", d."leftAt",
    jt.name AS "jobTitle", e."memberId" IS NOT NULL AS "addedByHand", e."acceptedAt" IS NOT NULL AS "paperworkAccepted", coalesce(sl."startedAt", a."startedAt") AS since, CASE WHEN st.id IS NOT NULL THEN sm.name WHEN a."mcId" IS NULL AND d.status <> 'LEFT' THEN '${NO_MC}' ELSE m.name END AS mc, a."mcId" IS NOT NULL OR st.id IS NOT NULL AS placed, coalesce(e."startDateKnown", true) AS "startDateKnown",
    coalesce(e."periodDateKnown", true) OR (SELECT count(*) FROM member_assignments p WHERE p."memberId" = d.id) + (SELECT count(*) FROM member_support_links p WHERE p."supportId" = d.id) > 1 AS "sinceKnown", coalesce(st.id, t.id) AS "teamId", coalesce(st.name, t.name) AS team, st.name AS "wholeTeam", (t."leadMemberId" = d.id) IS TRUE AS lead,
    sl."dispatcherId", CASE WHEN sd.id IS NULL THEN NULL ELSE sd."firstName" || ' ' || sd."lastName" END AS dispatcher,
    ${companyEmailSql()} AS "companyEmail",
    n."lastDay"::text AS "lastDay", n."lastDay" < ${earliest}::date AS "lastDayPassed",
    CASE WHEN n.id IS NULL THEN NULL ELSE (SELECT count(*)::integer FROM driver_assignments da WHERE da."memberId" = d.id AND da."endedAt" IS NULL) END AS "driversToReassign",
    CASE WHEN n.id IS NULL THEN NULL ELSE (SELECT count(*)::integer FROM member_support_links ml WHERE ml."dispatcherId" = d.id AND ml."endedAt" IS NULL) END AS "supportsToReassign",
    CASE WHEN n.id IS NULL OR rm.id IS NULL THEN NULL WHEN rm."completedAt" IS NOT NULL THEN 'COMPLETED' WHEN rm."removeNowAt" IS NULL AND rm."dueOn" > ${latest}::date THEN 'SCHEDULED' ELSE 'IN_PROGRESS' END AS "itRemoval",
    CASE WHEN lv.id IS NULL THEN NULL ELSE json_build_object('firstDay', lv."firstDay"::text, 'backOn', lv."backOn"::text, 'started', lv."startedAt" IS NOT NULL,
     'it', (SELECT CASE WHEN r.id IS NULL THEN 'NONE' WHEN r."completedAt" IS NOT NULL THEN 'SUSPENDED' ELSE 'IN_PROGRESS' END
      FROM (SELECT 1) one LEFT JOIN it_leave_requests r ON r."leaveId" = lv.id AND r.kind = 'SUSPEND' AND r."cancelledAt" IS NULL)) END AS leave,
    d."applicationId", d."jobTitleId", CASE WHEN st.id IS NOT NULL THEN sm.id ELSE m.id END AS "mcId", coalesce(st."leadMemberId", t."leadMemberId") AS "leadId",
    (SELECT l."firstName" || ' ' || l."lastName" FROM dispatch_members l WHERE l.id = coalesce(st."leadMemberId", t."leadMemberId")) AS "teamLead",
    (SELECT count(*)::integer FROM driver_assignments x WHERE x."memberId" = d.id AND x."endedAt" IS NULL) AS drivers
   FROM dispatch_members d LEFT JOIN job_titles jt ON jt.id = d."jobTitleId" LEFT JOIN existing_member_records e ON e."memberId" = d.id
   LEFT JOIN LATERAL (SELECT * FROM member_support_links l WHERE l."supportId" = d.id AND l."endedAt" IS NULL AND d.position = 'SUPPORT' LIMIT 1) sl ON true
   LEFT JOIN dispatch_members sd ON sd.id = sl."dispatcherId" LEFT JOIN teams st ON st.id = sl."teamId" LEFT JOIN mcs sm ON sm.id = st."mcId"
   LEFT JOIN LATERAL (SELECT * FROM member_assignments x WHERE x."memberId" = coalesce(sl."dispatcherId", d.id) ORDER BY x."startedAt" DESC, x."createdAt" DESC LIMIT 1) a ON true
   LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN teams t ON t.id = a."teamId"
   LEFT JOIN member_notices n ON n."memberId" = d.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL
   LEFT JOIN it_removal_requests rm ON rm."memberId" = d.id AND rm."cancelledAt" IS NULL
   -- Leave (section 35): the open leave, upcoming or started, and how far IT's suspend checklist is.
   LEFT JOIN member_leaves lv ON lv."memberId" = d.id AND lv."endedAt" IS NULL`;

/** The tabs of Dispatch › Dispatchers, each a condition on a row of memberRowsSql(). Paperwork has its own route. */
export const MEMBER_TABS = ['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'LEAVING', 'LEFT', 'MISSING', 'ALL'] as const;
export type MemberTab = typeof MEMBER_TABS[number];
const TAB_SQL: Record<MemberTab, string> = {
 ONBOARDING: `b.status = 'ONBOARDING'`, ACTIVE: `b.status = 'ACTIVE'`, ON_LEAVE: 'b.leave IS NOT NULL', LEAVING: `b."lastDay" IS NOT NULL`, LEFT: `b.status = 'LEFT'`,
 // Missing details, as features/dispatch/types.ts missingDetails: no start date recorded, or a dispatcher with no MC yet.
 MISSING: `b.status <> 'LEFT' AND (NOT b."startDateKnown" OR (b.position = 'DISPATCHER' AND NOT b.placed))`, ALL: 'true',
};
/** The tab a request asks for: everyone when it names none, as the whole-list answer does, and for an older web's ARCHIVED. */
const memberTab = (status?: MemberViewDto['status']): MemberTab => !status || status === 'ARCHIVED' ? 'ALL' : status;
const COUNT_KEYS: Record<MemberTab, string> = { ONBOARDING: 'onboarding', ACTIVE: 'active', ON_LEAVE: 'onLeave', LEAVING: 'leaving', LEFT: 'left', MISSING: 'missing', ALL: 'all' };
// The Paperwork tab's count, as GET dispatch/paperwork lists it (added by hand, not left, not accepted), so it follows the filters too.
const PAPERWORK_SQL = `b."addedByHand" AND b.status <> 'LEFT' AND NOT b."paperworkAccepted"`;
// Sorting puts what has no value last either way: supports and updaters have no drivers, and an unrecorded start date only holds the day they were added.
const SORTS: Record<MemberListQueryDto['sort'] & string, string> = {
 name: 'lower(b."firstName"), lower(b."lastName")', mc: 'lower(b.mc)', team: 'lower(b.team)', lead: 'lower(b."teamLead")', drivers: `CASE WHEN b.position = 'DISPATCHER' THEN b.drivers END`,
 since: 'CASE WHEN b."sinceKnown" THEN b.since END', status: `CASE WHEN b."lastDay" IS NOT NULL THEN 2 WHEN b.leave IS NOT NULL THEN 1 WHEN b.status = 'ONBOARDING' THEN 0 WHEN b.status = 'LEFT' THEN 4 ELSE 3 END`,
};
export const EXPORT_LIMIT = 2000;

/**
 * A person's IT setups, as companyEmailSql reads them: by application, and support setups by member, as two sides so each
 * uses its index (an OR of the two can use neither).
 */
const SETUPS = `(SELECT r.* FROM it_onboarding_requests r WHERE r."applicationId" = b."applicationId" AND r."cancelledAt" IS NULL
   UNION ALL SELECT r.* FROM it_onboarding_requests r WHERE r."memberId" = b.id AND r."cancelledAt" IS NULL)`;
/** An application answer, unless an administrator corrected it: a corrected value that was cleared stays cleared. */
const corrected = (key: string, answer: string) => `CASE WHEN dm."correctedDetails" ? '${key}' THEN dm."correctedDetails"->>'${key}' ELSE ${answer} END`;
/** A person's contact details with what each one is, for search: company accounts, personal contacts, staff-added ones, and other and legal names (section 33). */
const CONTACT_POINTS = `(
   SELECT x.label, x.value FROM ${SETUPS} r CROSS JOIN LATERAL (VALUES ('Company email', r."companyEmail"), ('RingCentral number', r."assignedRingCentralPhoneNumber"),
     ('RingCentral extension', r."ringCentralExtension")) x(label, value)
   UNION ALL SELECT x.label, x.value FROM existing_member_records e CROSS JOIN LATERAL (VALUES ('Company email', e."companyEmail"), ('RingCentral number', e."ringCentralNumber"),
     ('RingCentral extension', e."ringCentralExtension"), ('Personal email', e."personalEmail"), ('Personal phone', e."personalPhone"), ('Telegram', e.telegram)) x(label, value) WHERE e."memberId" = b.id
   UNION ALL SELECT x.label, x.value FROM dispatcher_applications a JOIN invitations i ON i.id = a."invitationId" JOIN dispatch_members dm ON dm.id = b.id
     LEFT JOIN LATERAL (SELECT s.fields FROM application_submissions s WHERE s."applicationId" = a.id ORDER BY s.version DESC LIMIT 1) s ON true
     CROSS JOIN LATERAL (VALUES ('Personal email', ${corrected('personalEmail', 'i.email')}), ('Personal phone', ${corrected('personalPhoneNumber', `s.fields->>'personalPhoneNumber'`)}),
     ('Telegram', ${corrected('telegram', `s.fields->>'telegram'`)})) x(label, value) WHERE a.id = b."applicationId"
   UNION ALL SELECT 'Other name', o.name || coalesce(' at ' || om.name, '') FROM member_other_names o LEFT JOIN mcs om ON om.id = o."mcId" WHERE o."memberId" = b.id UNION ALL SELECT 'Legal name', concat_ws(' ', e."legalFirstName", e."legalLastName") FROM existing_member_records e WHERE e."memberId" = b.id AND (e."legalFirstName" IS NOT NULL OR e."legalLastName" IS NOT NULL)
   UNION ALL SELECT CASE WHEN c.kind = 'EMAIL' THEN 'Added email' ELSE 'Added phone' END, c.value FROM member_contacts c WHERE c."memberId" = b.id AND c."removedAt" IS NULL
   UNION ALL SELECT x.label || coalesce(' at ' || coalesce(xm.name, a."companyName"), ''), x.value FROM member_company_accounts a LEFT JOIN mcs xm ON xm.id = a."mcId"
     CROSS JOIN LATERAL (VALUES ('Company email', a."companyEmail"), ('RingCentral number', a."ringCentralNumber"), ('RingCentral extension', a."ringCentralExtension")) x(label, value) WHERE a."memberId" = b.id
  ) p WHERE p.value IS NOT NULL`;

/** What a search for this text matches: words anywhere, and a number by its digits whatever the separators (with or without the US 1). */
export function searchTerms(search: string): { text: string; digits: string | null } {
 const text = search.trim().toLowerCase().replace(/^@/, '');
 const numberLike = /^[\d\s()+.-]+$/.test(search.trim()), digits = search.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
 return { text, digits: numberLike && digits.length >= 3 ? digits : null };
}
const escapeLike = (value: string) => value.replace(/[\\%_]/g, match => `\\${match}`);

/**
 * Dispatch › Dispatchers on the server (designed as the Dispatchers table group and approved
 * 2026-11-13): filters, search by name or contact detail, sorting, pages and export. Every dispatch manager and administrator
 * reads every record, as on the dispatcher page.
 */
@Injectable()
export class MemberListService {
 constructor(private readonly db: DataSource) {}

 /** The WHERE clause for every filter but the tab, and its parameters ($1 and $2 are the Eastern dates memberRowsSql uses). */
 private filters(query: MemberFilters) {
  const params: unknown[] = [usDay('earliest'), usDay('latest')], where: string[] = [];
  const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
  if (query.mcId) where.push(`b."mcId" = ${add(query.mcId)}`);
  if (query.teamId === 'NONE') where.push(`b."mcId" IS NOT NULL AND b."teamId" IS NULL`);
  else if (query.teamId) where.push(`b."teamId" = ${add(query.teamId)}`);
  if (query.leadId) where.push(`b."leadId" = ${add(query.leadId)}`);
  if (query.jobTitleId) where.push(`b."jobTitleId" = ${add(query.jobTitleId)}`);
  if (query.position === 'DISPATCHER') where.push(`b.position = 'DISPATCHER'`);
  else if (query.position) where.push(`b.position = 'SUPPORT' AND b."supportType" = ${add(query.position)}`);
  if (query.source) where.push(query.source === 'ADDED' ? 'b."addedByHand"' : 'NOT b."addedByHand"');
  // Everyone holding an open seat on one load board account (section 33).
  if (query.loadBoardAccountId) where.push(`EXISTS (SELECT 1 FROM member_load_board_seats s WHERE s."memberId" = b.id AND s.status <> 'ENDED' AND s."accountId" = ${add(query.loadBoardAccountId)})`);
  if (query.drivers) where.push(query.drivers === 'WITH' ? 'b.drivers > 0' : `b.position = 'DISPATCHER' AND b.drivers = 0`);
  let matched = 'NULL::json';
  if (query.search) {
   const { text, digits } = searchTerms(query.search), like = add(`%${escapeLike(text)}%`);
   const pointMatch = digits ? `regexp_replace(p.value, '\\D', '', 'g') LIKE ${add(`%${digits}%`)}` : `lower(p.value) LIKE ${like}`;
   const own = `lower(concat_ws(' ', b."firstName", b."lastName", b.mc, b.team, b."jobTitle", b."teamLead", b.dispatcher)) LIKE ${like}`;
   // Which contact detail matched, unless the name or place did: worked out once per row, in base(), and filtered on here.
   matched = `CASE WHEN ${own} THEN NULL ELSE (SELECT json_build_object('label', p.label, 'value', p.value) FROM ${CONTACT_POINTS} AND ${pointMatch} LIMIT 1) END`;
   where.push(`(${own} OR b.matched IS NOT NULL)`);
  }
  return { params, add, where: where.length ? where.join(' AND ') : 'true', matched };
 }
 /** The rows to filter, each with what its search matched. */
 private base(matched: string) {
  return `WITH a AS (${memberRowsSql('$1', '$2')}), b AS (SELECT b.*, ${matched} AS matched FROM a b) `;
 }

 private order(query: MemberViewDto, tab: MemberTab) {
  const direction = query.direction === 'desc' ? 'DESC' : 'ASC', name = 'lower(b."firstName"), lower(b."lastName"), b.id';
  // Leaving and On leave keep their own default order: soonest last day, soonest return.
  if (!query.sort && tab === 'LEAVING') return `b."lastDay", ${name}`;
  if (!query.sort && tab === 'ON_LEAVE') return `b.leave->>'backOn', ${name}`;
  const sort = query.sort ?? 'name';
  return sort === 'name' ? `lower(b."firstName") ${direction}, lower(b."lastName") ${direction}, b.id` : `${SORTS[sort]} ${direction} NULLS LAST, ${name}`;
 }

 async list(query: MemberListQueryDto) {
  const tab = memberTab(query.status), { params, add, where, matched } = this.filters(query), base = this.base(matched);
  const [counts] = await this.db.query(`${base}SELECT ${MEMBER_TABS.map(key => `count(*) FILTER (WHERE ${TAB_SQL[key]})::integer AS "${COUNT_KEYS[key]}"`).join(', ')}, count(*) FILTER (WHERE ${PAPERWORK_SQL})::integer AS paperwork FROM b WHERE ${where}`, params);
  const total: number = counts[COUNT_KEYS[tab]];
  if (query.only === 'counts') return { counts, total };
  const pageSize = query.pageSize ?? 20, pages = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(query.page ?? 1, pages);
  const limit = add(pageSize), offset = add((page - 1) * pageSize);
  const [items, options] = await Promise.all([
   this.db.query(`${base}SELECT b.* FROM b WHERE ${where} AND ${TAB_SQL[tab]} ORDER BY ${this.order(query, tab)} LIMIT ${limit} OFFSET ${offset}`, params), this.options()]);
  return { items, counts, total, page, pageSize, options };
 }

 /** What the filters offer: active MCs, teams, job titles and current team leads, plus archived ones someone still has. */
 private async options() {
  const [mcs, teams, leads, jobTitles, loadBoardAccounts] = await Promise.all([
   this.db.query(`SELECT m.id, m.name, m."archivedAt" IS NOT NULL AS archived FROM mcs m WHERE m."archivedAt" IS NULL
     OR EXISTS (SELECT 1 FROM member_assignments a WHERE a."mcId" = m.id) OR EXISTS (SELECT 1 FROM teams t WHERE t."mcId" = m.id AND t."archivedAt" IS NULL) ORDER BY lower(m.name)`),
   this.db.query(`SELECT t.id, t.name, t."mcId", t."archivedAt" IS NOT NULL AS archived FROM teams t WHERE t."archivedAt" IS NULL
     OR EXISTS (SELECT 1 FROM member_assignments a WHERE a."teamId" = t.id) OR EXISTS (SELECT 1 FROM member_support_links l WHERE l."teamId" = t.id) ORDER BY lower(t.name)`),
   this.db.query(`SELECT DISTINCT d.id, d."firstName" || ' ' || d."lastName" AS name, lower(d."firstName"), lower(d."lastName") FROM teams t JOIN dispatch_members d ON d.id = t."leadMemberId"
     WHERE t."archivedAt" IS NULL ORDER BY lower(d."firstName"), lower(d."lastName")`),
   this.db.query(`SELECT j.id, j.name, j."archivedAt" IS NOT NULL AS archived FROM job_titles j WHERE j."archivedAt" IS NULL OR EXISTS (SELECT 1 FROM dispatch_members d WHERE d."jobTitleId" = j.id) ORDER BY lower(j.name)`),
   this.db.query(`SELECT a.id, a.name, a.provider, a."archivedAt" IS NOT NULL AS archived FROM load_board_accounts a WHERE a."archivedAt" IS NULL
     OR EXISTS (SELECT 1 FROM member_load_board_seats s WHERE s."accountId" = a.id AND s.status <> 'ENDED') ORDER BY a.placeholder, a."nameKey"`),
  ]);
  return { mcs, teams, leads: leads.map(({ id, name }: { id: string; name: string }) => ({ id, name })), jobTitles, loadBoardAccounts };
 }

 /**
  * The view on screen, every page of it, with work details only: never personal email or phone, legal names, sign-ins or
  * reasons. Rate-limited, and recorded with the count and the filters used, never the rows.
  */
 async export(user: User, query: MemberViewDto) {
  await onboardingLimit(this.db, `members-export:${user.id}`, 10, 900);
  const tab = memberTab(query.status), { params, where, matched } = this.filters(query), base = this.base(matched);
  const [{ total }] = await this.db.query(`${base}SELECT count(*)::integer AS total FROM b WHERE ${where} AND ${TAB_SQL[tab]}`, params);
  if (total > EXPORT_LIMIT) throw new BadRequestException(`This view has ${total} people. Narrow the filters to ${EXPORT_LIMIT.toLocaleString('en-US')} or fewer to export.`);
  const rows = await this.db.query(`${base}SELECT b.id, b."firstName", b."lastName", b.position, b."supportType", b.mc, b.team, b."teamLead", b."jobTitle", b.since, b."sinceKnown", b.status, b."lastDay", b.leave,
    b."wholeTeam", b.dispatcher, b."companyEmail",
    coalesce((SELECT r."assignedRingCentralPhoneNumber" FROM ${SETUPS} r WHERE r."assignedRingCentralPhoneNumber" IS NOT NULL ORDER BY r."createdAt" DESC LIMIT 1),
     (SELECT e."ringCentralNumber" FROM existing_member_records e WHERE e."memberId" = b.id)) AS "ringCentralNumber",
    coalesce((SELECT r."ringCentralExtension" FROM ${SETUPS} r WHERE r."ringCentralExtension" IS NOT NULL ORDER BY r."createdAt" DESC LIMIT 1),
     (SELECT e."ringCentralExtension" FROM existing_member_records e WHERE e."memberId" = b.id)) AS "ringCentralExtension",
    (SELECT ${corrected('telegram', `coalesce(s.fields->>'telegram', e.telegram)`)} FROM dispatch_members dm LEFT JOIN existing_member_records e ON e."memberId" = dm.id
      LEFT JOIN LATERAL (SELECT x.fields FROM application_submissions x WHERE x."applicationId" = dm."applicationId" ORDER BY x.version DESC LIMIT 1) s ON true WHERE dm.id = b.id) AS telegram
   FROM b WHERE ${where} AND ${TAB_SQL[tab]} ORDER BY ${this.order(query, tab)}`, params);
  const used = (['search', 'mcId', 'teamId', 'leadId', 'jobTitleId', 'position', 'source', 'drivers', 'loadBoardAccountId'] as const).filter(key => query[key]);
  await this.db.getRepository(DispatchEvent).save({ memberId: null, teamId: null, event: 'MEMBERS_EXPORTED', actorId: user.id, metadata: { count: rows.length, tab, filters: used } });
  return { items: rows, total };
 }
}
