import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, In, IsNull, Not } from 'typeorm';
import { webOrigins } from '../../config/environment';
import { listNameKey } from '../lists/lists.entity';
import { INTERNATIONAL_PHONE_PATTERN } from '../onboarding/application-requirements';
import { ApplicationActivity, DispatcherApplication, Invitation } from '../onboarding/entities';
import { onboardingLimit } from '../onboarding/rate-limit';
import { digest } from '../onboarding/verification-code';
import { usDay } from '../safety/screening-rules';
import { Role, type User } from '../users/user.entity';
import { ItRemovalActivity, ItRemovalRequest, ItRemovalTask } from '../it/it.entity';
import { createRemoval, memberSetups, removalTaskKeys, setupAccounts } from '../it/removal';
import { NotificationsService } from '../updates/notifications.service';
import { EXTENSION, signInsInUse, telegramUsername } from './account-details';
import { lockCatchUpLinks, lockTeam, memberPlace, paperworkTimeEnded, supportedDispatcher } from './create-member';
import { DispatchEvent, DispatchMember, ExistingMemberRecord, MemberAssignment, MemberNotice, MemberOtherName, MemberPaperDocument, MemberSupportLink, NO_MC, Position, positionLabel, SupportType, Team } from './dispatch.entity';
import { CloseAccountsDto, ExistingRowDto, LeftDayDto, MemberNamesDto, UpdateExistingDto } from './dispatch.dto';

export const IMPORT_LOCK = 42002037;
const LINK_DAYS = 14, NOT_LISTED_TEAM = 'No team yet', INDEPENDENT = 'Independent';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The same phone written with or without the US country code.
const digits = (value: string) => value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const text = (value?: string) => (value ?? '').trim();

/** A date from the file: 2024-03-04 or 3/4/2024. Null when it isn't a real date. */
export function fileDate(value: string): string | null {
 const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value), us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
 const [year, month, date] = iso ? [+iso[1], +iso[2], +iso[3]] : us ? [+us[3], +us[1], +us[2]] : [0, 0, 0];
 if (!year) return null;
 const parsed = new Date(Date.UTC(year, month - 1, date));
 if (parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== date) return null;
 return parsed.toISOString().slice(0, 10);
}
/** The position column, read in one place. Empty means Dispatcher; anything it can't read is a problem on its row, and still counts as Dispatcher until it's corrected. */
function readPosition(value: string): { position: Position; supportType: SupportType; known: boolean } {
 const key = value.toLowerCase();
 if (key === 'support' || key === 'updater') return { position: 'SUPPORT', supportType: key === 'updater' ? 'UPDATER' : 'SUPPORT', known: true };
 return { position: 'DISPATCHER', supportType: 'SUPPORT', known: !key || key === 'dispatcher' };
}
const aSupport = (type: SupportType) => type === 'UPDATER' ? 'an updater' : 'a support';
const capitalized = (text: string) => text[0].toUpperCase() + text.slice(1);
/** A team by its own name, or failing that by its lead's: a name that matches one team and another team's lead means the team it names. */
function matchingTeams<T extends { name: string; lead: string | null }>(teams: T[], text: string) {
 const key = listNameKey(text), named = teams.filter(item => listNameKey(item.name) === key);
 return named.length ? named : teams.filter(item => listNameKey(item.lead ?? '') === key);
}
/** Where someone who left last worked, for what IT sees on their removal. */
async function lastPlace(em: EntityManager, id: string): Promise<{ mcName: string | null; teamName: string | null }> {
 const [row] = await em.query(`SELECT m.name AS "mcName", t.name AS "teamName" FROM member_assignments a LEFT JOIN mcs m ON m.id = a."mcId" LEFT JOIN teams t ON t.id = a."teamId"
  WHERE a."memberId" = $1 ORDER BY a."startedAt" DESC, a."createdAt" DESC LIMIT 1`, [id]);
 return { mcName: row?.mcName ?? null, teamName: row?.teamName ?? null };
}
/** Stored at midday UTC, as dates picked in forms are, so it shows as the same day in every US time zone. */
const midday = (date: string) => new Date(`${date}T12:00:00Z`);

export type RowStatus = 'READY' | 'CHOICE' | 'PROBLEM' | 'ALREADY';
/** What can be done with a row that matches someone already recorded (section 33). Leaving it means the row is skipped. */
export type AlreadyOption = 'FILL' | 'CAME_BACK' | 'DIFFERENT';
export interface AlreadyMatch { id: string; name: string; status: string; why: string; options: AlreadyOption[]; fills: string[] }
export interface RowResult { row: number; name: string; position: 'DISPATCHER' | 'SUPPORT'; supportType: SupportType; status: RowStatus; problems: string[]; sameName: boolean;
 mcId: string | null; teamId: string | null; jobTitleId: string | null; supportsMemberId: string | null; supportsTeamId: string | null; supportsRow: number | null; startedOn: string | null; noMc: boolean; mcFromTeam: boolean; sharesSignIn: boolean;
 left: boolean; leftOn: string | null; hasAccounts: boolean; askIt: boolean; otherNames: string[]; match: AlreadyMatch | null; fill: boolean; previousMemberId: string | null }
// forSupports: the same team text on support and updater rows is its own choice, because they need a real team.
export interface Choice { field: 'mc' | 'team' | 'jobTitle'; text: string; mc?: string; forSupports?: boolean; rows: number[] }

/** A member as the check sees them: current or left, added by hand or not, and whether a later record already came back from them. */
interface KnownMember { id: string; name: string; position: string; status: string; mc: string | null; placed: boolean; leaving: boolean; handAdded: boolean; returned: boolean; leftOn: string | null }
/** What a manager recorded for someone added by hand, to fill only what's missing. */
interface KnownRecord { memberId: string; companyEmail: string | null; ringCentralNumber: string | null; ringCentralExtension: string | null; personalEmail: string | null; personalPhone: string | null;
 telegram: string | null; datEmail: string | null; truckstopEmail: string | null; legalFirstName: string | null; legalLastName: string | null; leftDateKnown: boolean; otherNames: string[] }
interface Known {
 mcs: Map<string, { id: string; name: string }>; teams: { id: string; name: string; mcId: string; lead: string | null }[]; titles: Map<string, string>;
 // Archived ones too, for people who left: where they last worked may no longer be on the lists.
 allMcs: Map<string, { id: string; name: string }>; allTeams: { id: string; name: string; mcId: string; lead: string | null }[]; allTitles: Map<string, string>;
 members: KnownMember[]; byId: Map<string, KnownMember>; records: Map<string, KnownRecord>;
 // Each contact detail with the people it belongs to, current or left.
 companyEmails: Map<string, string[]>; personalEmails: Map<string, string[]>; phones: Map<string, string[]>;
}
const NAME = /^[A-Za-z][A-Za-z .'-]*$/;
/** The status column: Active (or blank) or Left. Suspended means on leave, which isn't a status: they're added as Active and put on leave from their page. */
function readStatus(value: string): { left: boolean; problem?: string } {
 const key = value.trim().toLowerCase();
 if (!key || key === 'active') return { left: false };
 if (key === 'left') return { left: true };
 if (key === 'suspended') return { left: false, problem: 'Status says “Suspended”. Use Active or Left, then put them on leave from their page.' };
 return { left: false, problem: `Status “${value.trim()}” should be Active or Left.` };
}
/** Other names, separated by ; in the file. */
const splitNames = (value?: string) => [...new Set(text(value).split(';').map(item => item.trim().replace(/\s+/g, ' ')).filter(Boolean))];
const accountFields = ['companyEmail', 'ringCentralNumber', 'ringCentralExtension', 'personalEmail', 'personalPhone', 'telegram', 'datEmail', 'truckstopEmail'] as const;
const FIELD_LABELS: Record<string, string> = { companyEmail: 'company email', ringCentralNumber: 'RingCentral number', ringCentralExtension: 'extension', personalEmail: 'personal email', personalPhone: 'personal phone', telegram: 'Telegram', datEmail: 'DAT sign-in', truckstopEmail: 'Truckstop sign-in', legalName: 'legal name', lastDay: 'last day', leftReason: 'reason for leaving' };
/**
 * People already working here (designed and approved 2026-11-02). Rows come from a CSV the browser reads, or from the
 * one-person form: nothing is kept but the records, each row is checked again when it is added, and the file never reaches
 * storage. Each person becomes Active with no application, IT setup, alert or message; the paperwork catches up through a
 * link the manager sends, reviewed in ReviewService. Events hold counts and flags, never values.
 */
@Injectable()
export class ExistingDispatchersService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService, private readonly alerts: NotificationsService) {}
 private get fictionalOnly() { return !(this.config.get('NODE_ENV') === 'production' || this.config.get('DEPLOYMENT_PURPOSE') === 'production'); }

 async options() {
  const [mcs, teams, jobTitles] = await Promise.all([
   this.db.query(`SELECT id, name FROM mcs WHERE "archivedAt" IS NULL ORDER BY "nameKey"`),
   this.db.query(`SELECT t.id, t.name, t."mcId", CASE WHEN l.id IS NULL THEN NULL ELSE l."firstName" || ' ' || l."lastName" END AS lead
    FROM teams t LEFT JOIN dispatch_members l ON l.id = t."leadMemberId" WHERE t."archivedAt" IS NULL ORDER BY t."nameKey"`),
   this.db.query(`SELECT id, name FROM job_titles WHERE "archivedAt" IS NULL ORDER BY "nameKey"`)]);
  const dispatchers = await this.db.query(`SELECT d.id, d."firstName" || ' ' || d."lastName" AS name, CASE WHEN a."mcId" IS NULL THEN '${NO_MC}' ELSE m.name END AS mc FROM dispatch_members d
   LEFT JOIN member_assignments a ON a."memberId" = d.id AND a."endedAt" IS NULL LEFT JOIN mcs m ON m.id = a."mcId"
   WHERE d.position = 'DISPATCHER' AND d.status <> 'LEFT' AND NOT EXISTS (SELECT 1 FROM member_notices n WHERE n."memberId" = d.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL)
   ORDER BY lower(d."firstName"), lower(d."lastName")`);
  return { mcs, teams, jobTitles, dispatchers };
 }
 private async known(em: EntityManager): Promise<Known> {
  const mcs: { id: string; name: string; archived: boolean }[] = await em.query(`SELECT id, name, "archivedAt" IS NOT NULL AS archived FROM mcs`);
  const teams: { id: string; name: string; mcId: string; lead: string | null; archived: boolean }[] = await em.query(`SELECT t.id, t.name, t."mcId", t."archivedAt" IS NOT NULL AS archived,
    CASE WHEN l.id IS NULL THEN NULL ELSE l."firstName" || ' ' || l."lastName" END AS lead FROM teams t LEFT JOIN dispatch_members l ON l.id = t."leadMemberId"`);
  const titles: { id: string; name: string; archived: boolean }[] = await em.query(`SELECT id, name, "archivedAt" IS NOT NULL AS archived FROM job_titles`);
  // Everyone, current or left. For someone who left, their MC is where they last worked.
  const members: KnownMember[] = await em.query(`SELECT d.id, d."firstName" || ' ' || d."lastName" AS name, d.position, d.status, m.name AS mc, a.id IS NOT NULL AND a."endedAt" IS NULL AS placed,
    EXISTS (SELECT 1 FROM member_notices n WHERE n."memberId" = d.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL) AS leaving, e."memberId" IS NOT NULL AS "handAdded",
    EXISTS (SELECT 1 FROM dispatch_members x WHERE x."previousMemberId" = d.id) AS returned,
    CASE WHEN d.status = 'LEFT' AND coalesce(e."leftDateKnown", true) THEN to_char(d."leftAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') END AS "leftOn"
   FROM dispatch_members d LEFT JOIN existing_member_records e ON e."memberId" = d.id
   LEFT JOIN LATERAL (SELECT * FROM member_assignments x WHERE x."memberId" = d.id AND (x."endedAt" IS NULL OR d.status = 'LEFT') ORDER BY x."startedAt" DESC, x."createdAt" DESC LIMIT 1) a ON true
   LEFT JOIN mcs m ON m.id = a."mcId"`);
  // Every contact detail with whose it is: added by hand, set up by IT, an applicant's verified email and phone, or added by a manager.
  const rows: { id: string; company: string | null; personal: string | null; phone: string | null }[] = await em.query(`
   SELECT r."memberId" AS id, r."companyEmail" AS company, r."personalEmail" AS personal, r."personalPhone" AS phone FROM existing_member_records r
   UNION ALL SELECT d.id, r."companyEmail", i.email, s.fields->>'personalPhoneNumber' FROM dispatch_members d JOIN dispatcher_applications a ON a.id = d."applicationId" JOIN invitations i ON i.id = a."invitationId"
    LEFT JOIN it_onboarding_requests r ON r."applicationId" = a.id LEFT JOIN LATERAL (SELECT fields FROM application_submissions x WHERE x."applicationId" = a.id ORDER BY x.version DESC LIMIT 1) s ON true
   UNION ALL SELECT r."memberId", r."companyEmail", NULL, NULL FROM it_onboarding_requests r WHERE r."memberId" IS NOT NULL AND r."companyEmail" IS NOT NULL AND r."cancelledAt" IS NULL
   UNION ALL SELECT c."memberId", CASE WHEN c.kind = 'EMAIL' THEN c.value END, CASE WHEN c.kind = 'EMAIL' THEN c.value END, CASE WHEN c.kind = 'PHONE' THEN c.value END FROM member_contacts c WHERE c."removedAt" IS NULL`);
  const owners = (pick: (row: typeof rows[number]) => string | null, normal: (value: string) => string) => {
   const map = new Map<string, string[]>();
   for (const row of rows) { const value = pick(row); if (!value) continue; const key = normal(value), ids = map.get(key) ?? []; if (!ids.includes(row.id)) ids.push(row.id); map.set(key, ids); }
   return map;
  };
  const records: KnownRecord[] = await em.query(`SELECT r."memberId", r."companyEmail", r."ringCentralNumber", r."ringCentralExtension", r."personalEmail", r."personalPhone", r.telegram, r."datEmail", r."truckstopEmail",
    r."legalFirstName", r."legalLastName", r."leftDateKnown", coalesce((SELECT array_agg(lower(o.name)) FROM member_other_names o WHERE o."memberId" = r."memberId"), '{}') AS "otherNames" FROM existing_member_records r`);
  const active = <T extends { archived: boolean }>(items: T[]) => items.filter(item => !item.archived);
  return { mcs: new Map(active(mcs).map(item => [listNameKey(item.name), item])), teams: active(teams), titles: new Map(active(titles).map(item => [listNameKey(item.name), item.id])),
   allMcs: new Map([...mcs].sort((a, b) => Number(b.archived) - Number(a.archived)).map(item => [listNameKey(item.name), item])), allTeams: teams, allTitles: new Map([...titles].sort((a, b) => Number(b.archived) - Number(a.archived)).map(item => [listNameKey(item.name), item.id])),
   members, byId: new Map(members.map(item => [item.id, item])), records: new Map(records.map(item => [item.memberId, item])),
   companyEmails: owners(row => row.company, value => value.toLowerCase()), personalEmails: owners(row => row.personal, value => value.toLowerCase()), phones: owners(row => row.phone, digits) };
 }
 /** Whether a contact detail belongs to someone here now other than this person. */
 private static usedByCurrent(known: Known, map: Map<string, string[]>, value: string, except?: string) {
  return (map.get(value) ?? []).some(id => id !== except && known.byId.get(id)?.status !== 'LEFT');
 }
 /** Checks every row against the lists and the people already recorded. Pure: nothing is written. */
 private evaluate(rows: ExistingRowDto[], known: Known, signIns: Set<string>) {
  const today = usDay('latest'), choices = new Map<string, Choice>();
  const current = known.members.filter(item => item.status !== 'LEFT'), gone = known.members.filter(item => item.status === 'LEFT');
  const choice = (entry: Omit<Choice, 'rows'>, row: number) => {
   const key = `${entry.field}|${entry.forSupports ? 'supports' : ''}|${listNameKey(entry.mc ?? '')}|${listNameKey(entry.text)}`;
   const found = choices.get(key) ?? { ...entry, rows: [] };
   found.rows.push(row); choices.set(key, found);
  };
  const seenCompany = new Map<string, number>(), seenPersonal = new Map<string, number>(), seenPhone = new Map<string, number>(), seenName = new Map<string, number>(), seenAnyName = new Map<string, number>(), seenNoMc = new Map<string, number>();
  const results: RowResult[] = rows.map(row => {
   const first = text(row.firstName), last = text(row.lastName), problems: string[] = [], { position, supportType, known: positionKnown } = readPosition(text(row.position));
   const name = `${first} ${last}`.trim(), status = readStatus(text(row.status)), left = status.left;
   let state: RowStatus = 'READY', mcId: string | null = null, teamId: string | null = null, jobTitleId: string | null = null, supportsTeamId: string | null = null, already = '', sameName = false, noMc = false, mcFromTeam = false;
   let match: AlreadyMatch | null = null, previousMemberId: string | null = null;
   if (!first || !last) problems.push('First and last name are both needed.');
   if (first.length > 100 || last.length > 100) problems.push('Names can be up to 100 characters.');
   if (!positionKnown) problems.push(`Position “${text(row.position)}” should be Dispatcher, Support or Updater.`);
   if (status.problem) problems.push(status.problem);
   const started = text(row.startedOn), startedOn = started ? fileDate(started) : null;
   // An empty start date is fine: it can be added on their page later. A date that can't be read is a mistake to fix.
   if (started && !startedOn) problems.push(`Started on “${started}” isn’t a date.`);
   else if (startedOn && startedOn > today) problems.push('Started on can’t be in the future.');
   else if (startedOn && startedOn < '1980-01-01') problems.push(`Started on “${started}” is too long ago.`);
   // Someone who left: the last day may be blank (not recorded yet), and a reason without health or other private details.
   const leftText = text(row.leftOn), leftOn = left && leftText ? fileDate(leftText) : null, reason = text(row.leftReason);
   if (!left && (leftText || reason)) problems.push('A last day or reason is only for someone who left. Set their status to Left, or leave these empty.');
   if (left && leftText && !leftOn) problems.push(`Last day “${leftText}” isn’t a date.`);
   else if (leftOn && leftOn > today) problems.push('The last day can’t be in the future. For someone still working here, record their notice on their page.');
   else if (leftOn && startedOn && leftOn < startedOn) problems.push('The last day can’t be before they started.');
   else if (leftOn && leftOn < '1980-01-01') problems.push(`Last day “${leftText}” is too long ago.`);
   if (reason.length > 500) problems.push('The reason can be up to 500 characters.');
   for (const [label, value] of [['NDA', text(row.ndaSignedOn)], ['SOP', text(row.sopSignedOn)]] as const) {
    if (!value) continue;
    const date = fileDate(value);
    if (!date) problems.push(`${label} signed on “${value}” isn’t a date.`);
    else if (date > today) problems.push(`${label} signed on can’t be in the future.`);
   }
   // Legal and other names, in Latin letters like every name in the workspace.
   const legalFirst = text(row.legalFirstName), legalLast = text(row.legalLastName), otherNames = splitNames(row.otherNames);
   if ([legalFirst, legalLast].some(value => value && (value.length > 100 || !NAME.test(value)))) problems.push('The legal name uses Latin letters, up to 100 each.');
   if (otherNames.length > 10) problems.push('Up to 10 other names.');
   if (otherNames.some(value => value.length > 100 || !NAME.test(value))) problems.push('Other names use Latin letters, separated by ;.');
   const company = text(row.companyEmail).toLowerCase(), personal = text(row.personalEmail).toLowerCase(), number = text(row.ringCentralNumber), phone = text(row.personalPhone);
   for (const [label, value] of [['Company email', company], ['Personal email', personal]] as const) {
    if (!value) continue;
    if (!EMAIL.test(value) || value.length > 254) problems.push(`${label} “${value}” doesn’t look right.`);
    else if (this.fictionalOnly && !value.endsWith('@example.test')) problems.push(`Outside production, ${label.toLowerCase()} must be a fictional example.test address.`);
   }
   for (const [label, value] of [['RingCentral number', number], ['Personal phone', phone]] as const) if (value && (value.length > 40 || !INTERNATIONAL_PHONE_PATTERN.test(value))) problems.push(`${label} “${value}” should have 7 to 15 digits.`);
   if (text(row.telegram) && !telegramUsername(text(row.telegram))) problems.push('Telegram should be a username, like @alexmoreno.');
   if (text(row.ringCentralExtension) && !EXTENSION.test(text(row.ringCentralExtension))) problems.push('The extension should be digits, up to 6.');
   // Never repeats what was in the cell: it may be a password.
   for (const [label, value] of [['DAT', text(row.datEmail).toLowerCase()], ['Truckstop', text(row.truckstopEmail).toLowerCase()]] as const) {
    if (!value) continue;
    if (!EMAIL.test(value) || value.length > 254) problems.push(`The ${label} sign-in isn’t an email address. This column takes the sign-in email only, never a password.`);
    else if (this.fictionalOnly && !value.endsWith('@example.test')) problems.push(`Outside production, the ${label} sign-in must be a fictional example.test address.`);
   }
   // Someone already recorded, by a contact detail: here now first, then someone who left.
   const contactMatches: { id: string; label: string }[] = [];
   for (const [value, map, label] of [[company, known.companyEmails, 'company email'], [personal, known.personalEmails, 'personal email'], [phone ? digits(phone) : '', known.phones, 'personal phone']] as const) {
    if (value) for (const id of map.get(value) ?? []) if (!contactMatches.some(item => item.id === id)) contactMatches.push({ id, label });
   }
   const hereNow = contactMatches.find(item => known.byId.get(item.id)?.status !== 'LEFT'), wentAway = contactMatches.find(item => known.byId.get(item.id)?.status === 'LEFT');
   if (hereNow) {
    const person = known.byId.get(hereNow.id)!;
    already = left ? `Same ${hereNow.label} as ${person.name}, who works here now. This row is left out.` : `Already in the workspace with this ${hereNow.label}. This row is left out.`;
    match = { id: person.id, name: person.name, status: person.status, why: `same ${hereNow.label} as ${person.name}`, options: left ? [] : ['FILL'], fills: [] };
   } else if (wentAway && !row.differentPerson) {
    const person = known.byId.get(wentAway.id)!, since = person.leftOn ? `, who left ${person.leftOn}` : ', who left';
    if (left) {
     already = `Already recorded as someone who left (same ${wentAway.label} as ${person.name}).`;
     match = { id: person.id, name: person.name, status: person.status, why: `same ${wentAway.label} as ${person.name}${since}`, options: ['FILL', 'DIFFERENT'], fills: [] };
    } else if (row.alreadyAction === 'CAME_BACK' && !person.returned) previousMemberId = person.id;
    else {
     already = person.returned ? `Same ${wentAway.label} as ${person.name}, who left and has already come back. This row is left out.` : `Same ${wentAway.label} as ${person.name}${since}. Choose if they came back.`;
     match = { id: person.id, name: person.name, status: person.status, why: `same ${wentAway.label} as ${person.name}${since}`, options: person.returned ? [] : ['CAME_BACK', 'DIFFERENT'], fills: [] };
    }
   }
   for (const [value, seen, label] of [[company, seenCompany, 'company email'], [personal, seenPersonal, 'personal email'], [phone ? digits(phone) : '', seenPhone, 'personal phone']] as const) {
    if (!value) continue;
    const earlier = seen.get(value);
    if (earlier !== undefined) problems.push(`Same ${label} as row ${earlier}.`); else seen.set(value, row.row);
   }
   // The same person twice in one file, however their contact details are written. The first row stays ready.
   const sameInFile = (key: string, label: string) => {
    const earlier = seenName.get(key);
    if (earlier === undefined) seenName.set(key, row.row);
    else if (!already && !row.differentPerson) { problems.push(`Same ${label} as row ${earlier}. Left out unless you say they’re different people.`); sameName = true; }
   };
   // Someone who left, by name and where they last worked: recorded already unless the row says otherwise.
   const leftByName = (mcName: string | null) => {
    const person = gone.find(item => item.position === position && listNameKey(item.name) === listNameKey(name) && (position === 'SUPPORT' || listNameKey(item.mc ?? '') === listNameKey(mcName ?? '')));
    if (!person || already || row.differentPerson) return;
    already = `Already recorded as someone who left (same name${position === 'DISPATCHER' ? ' and MC' : ''} as ${person.name}).`; sameName = true;
    match = { id: person.id, name: person.name, status: person.status, why: `same name${position === 'DISPATCHER' ? ' and MC' : ''} as ${person.name}, who left${person.leftOn ? ` ${person.leftOn}` : ''}`, options: ['FILL', 'DIFFERENT'], fills: [] };
   };
   if (position === 'DISPATCHER') {
    // Independent is a team choice under an MC (section 31): in the MC column it counts as a blank MC, so a team in the row
    // still brings its MC and with none they have no MC yet; in the team column (like No team yet) it means no team under the row's MC.
    const mcRaw = text(row.mc), mcText = listNameKey(mcRaw) === listNameKey(INDEPENDENT) ? '' : mcRaw, teamText = text(row.team), titleText = text(row.jobTitle);
    const named = listNameKey(mcText) !== listNameKey(NO_MC) && !!mcText, wantsTeam = !!teamText && ![NOT_LISTED_TEAM, INDEPENDENT].map(listNameKey).includes(listNameKey(teamText));
    // Someone who left may have worked for an MC or team that's archived now. A team nobody has now is left blank instead of asking.
    const mcList = left ? known.allMcs : known.mcs, teamList = left ? known.allTeams : known.teams, titleList = left ? known.allTitles : known.titles;
    const mc = named ? mcList.get(listNameKey(mcText)) : undefined;
    let teamMc: string | null = null;
    if (named && !mc) choice({ field: 'mc', text: mcText }, row.row);
    mcId = mc?.id ?? null;
    if (!named) {
     // Every team belongs to one MC, so a team with no MC brings its MC. "No MC yet" says to leave them out of any team for now.
     const teams = !mcText && wantsTeam ? matchingTeams(teamList, teamText) : [];
     const owner = teams.length === 1 ? [...mcList.values()].find(item => item.id === teams[0].mcId) : undefined;
     if (owner) { mcId = owner.id; teamId = teams[0].id; teamMc = owner.name; mcFromTeam = true; }
     else if (!mcText && wantsTeam && !left) choice({ field: 'team', text: teamText }, row.row);
     else noMc = true;
    }
    if (mc && wantsTeam) {
     const team = matchingTeams(teamList.filter(item => item.mcId === mc.id), teamText)[0];
     if (team) teamId = team.id; else if (!left) choice({ field: 'team', text: teamText, mc: mc.name }, row.row);
    }
    jobTitleId = titleList.get(listNameKey(titleText)) ?? null;
    // A position it can't read says so once: it may not be a dispatcher at all, so nothing is asked about a job title until it's corrected.
    // Someone who left needs a job title only when the file has one.
    if (positionKnown && !titleText && !left) problems.push('Job title is empty.');
    else if (positionKnown && titleText && !jobTitleId) choice({ field: 'jobTitle', text: titleText }, row.row);
    // A blank MC with a team we can't find is still to be chosen, so it can't match anyone's MC yet.
    const mcPending = !named && !noMc && !mcFromTeam, mcName = mc?.name ?? teamMc ?? mcText, nameKey = listNameKey(name);
    if (left) { if (!mcPending) leftByName(mcName); }
    else {
     // Someone with no MC yet could be anyone of that name, so setting their MC with a second upload can't add them twice.
     const sameNames = current.filter(item => item.position === 'DISPATCHER' && listNameKey(item.name) === nameKey);
     if (!already && !row.differentPerson && sameNames.some(item => !item.placed || noMc)) {
      already = 'Same name as someone in the workspace, and one of them has no MC yet. Left out unless you say they’re different people. To set an MC, use their page.'; sameName = true;
     } else if (!already && !row.differentPerson && !mcPending && sameNames.some(item => listNameKey(item.mc ?? '') === listNameKey(mcName ?? ''))) {
      already = 'Same name and MC as someone in the workspace. Left out unless you say they’re different people.'; sameName = true;
     }
    }
    if (name) {
     const earlier = noMc ? seenAnyName.get(nameKey) : seenNoMc.get(nameKey);
     if (earlier !== undefined && !already && !row.differentPerson) { problems.push(`Same name as row ${earlier}, and one of them has no MC yet. Left out unless you say they’re different people.`); sameName = true; }
     else if (!mcPending) sameInFile(`DISPATCHER|${left ? 'LEFT' : ''}|${nameKey}|${listNameKey(mcName ?? '')}`, 'name and MC');
     if (!seenAnyName.has(nameKey)) seenAnyName.set(nameKey, row.row);
     if (noMc && !seenNoMc.has(nameKey)) seenNoMc.set(nameKey, row.row);
    }
   } else {
    // A team and no dispatcher means the whole team. With a dispatcher named, any team in the row is ignored: they work where their dispatcher works.
    // Someone who left assisted somebody once; nothing about whom is needed now.
    const noMcText = listNameKey(text(row.mc)) === listNameKey(NO_MC), teamText = text(row.team), namesDispatcher = !!text(row.supports) || !!row.supportsMemberId;
    if ((text(row.mc) && !noMcText) || text(row.jobTitle)) problems.push(`${capitalized(aSupport(supportType))} has no MC or job title of their own. Leave them empty.`);
    if (!left) {
     if (row.supportsTeamId && namesDispatcher) problems.push('Choose a dispatcher or a team, not both.');
     if (row.supportsTeamId) {
      if (known.teams.some(item => item.id === row.supportsTeamId)) supportsTeamId = row.supportsTeamId; else problems.push(`Choose an active team for ${aSupport(supportType)}.`);
     } else if (!namesDispatcher && teamText) {
      const teams = matchingTeams(known.teams, teamText);
      if (teams.length === 1) supportsTeamId = teams[0].id; else choice({ field: 'team', text: teamText, forSupports: true }, row.row);
     }
     if (!already && !row.differentPerson && current.some(item => item.position === 'SUPPORT' && listNameKey(item.name) === listNameKey(name))) {
      already = 'Same name as a support or updater in the workspace. Left out unless you say they’re different people.'; sameName = true;
     }
    } else leftByName(null);
    if (name) sameInFile(`SUPPORT|${left ? 'LEFT' : ''}|${listNameKey(name)}`, 'name');
   }
   // What filling in would add to the record already there: only empty values, never a different one.
   if (match?.options.includes('FILL')) {
    const record = known.records.get(match.id), person = known.byId.get(match.id)!;
    if (!record) match.options = match.options.filter(option => option !== 'FILL');
    else {
     const values: Record<string, string> = { companyEmail: company, ringCentralNumber: number, ringCentralExtension: text(row.ringCentralExtension), personalEmail: personal, personalPhone: phone,
      telegram: telegramUsername(text(row.telegram)) ?? '', datEmail: text(row.datEmail).toLowerCase(), truckstopEmail: text(row.truckstopEmail).toLowerCase() };
     const usedElsewhere = (field: string, value: string) => (field === 'companyEmail' && ExistingDispatchersService.usedByCurrent(known, known.companyEmails, value, match!.id))
      || (field === 'personalEmail' && ExistingDispatchersService.usedByCurrent(known, known.personalEmails, value, match!.id)) || (field === 'personalPhone' && ExistingDispatchersService.usedByCurrent(known, known.phones, digits(value), match!.id));
     for (const field of accountFields) if (values[field] && !record[field] && !usedElsewhere(field, values[field])) match.fills.push(field);
     if ((legalFirst || legalLast) && !record.legalFirstName && !record.legalLastName) match.fills.push('legalName');
     const newNames = otherNames.filter(item => !record.otherNames.includes(item.toLowerCase()) && listNameKey(item) !== listNameKey(person.name));
     if (newNames.length) match.fills.push(`otherNames:${newNames.length}`);
     if (person.status === 'LEFT' && leftOn && !record.leftDateKnown) match.fills.push('lastDay');
     if (!match.fills.length) match.options = match.options.filter(option => option !== 'FILL');
    }
   }
   const fill = !!match && row.alreadyAction === 'FILL' && match.options.includes('FILL');
   if (already) { state = 'ALREADY'; problems.unshift(already); }
   const hasAccounts = left && !!(company || number || text(row.datEmail) || text(row.truckstopEmail));
   return { row: row.row, name, position, supportType, status: state, problems, sameName, mcId, teamId, jobTitleId, supportsMemberId: null, supportsTeamId, supportsRow: null, startedOn, noMc, mcFromTeam, sharesSignIn: false,
    left, leftOn, hasAccounts, askIt: hasAccounts && !!row.askIt, otherNames, match, fill, previousMemberId };
  });
  for (const result of results) if (result.status === 'READY' && result.problems.length) result.status = 'PROBLEM';
  for (const entry of choices.values()) for (const number of entry.rows) { const result = results.find(item => item.row === number)!; if (result.status === 'READY') result.status = 'CHOICE'; }
  // Supports last: their dispatcher may be another row in the same file.
  rows.forEach((row, index) => {
   const result = results[index];
   if (result.position !== 'SUPPORT' || result.status === 'ALREADY' || result.left) return;
   if (row.supportsMemberId) {
    const picked = current.find(item => item.id === row.supportsMemberId && item.position === 'DISPATCHER');
    if (!picked) { result.problems.push(`Choose a current dispatcher for ${aSupport(result.supportType)}.`); result.status = 'PROBLEM'; }
    else if (picked.leaving) { result.problems.push(`“${picked.name}” is leaving. Choose another dispatcher.`); result.status = 'PROBLEM'; }
    else result.supportsMemberId = picked.id;
    return;
   }
   const wanted = listNameKey(text(row.supports));
   if (!wanted) {
    if (result.supportsTeamId || choices.has(`team|supports||${listNameKey(text(row.team))}`)) return;
    result.problems.push('Name the dispatcher they assist, or the team if they assist everyone on it.'); result.status = 'PROBLEM'; return;
   }
   const here = current.filter(item => item.position === 'DISPATCHER' && listNameKey(item.name) === wanted);
   const inFile = results.filter(item => item.position === 'DISPATCHER' && !item.left && listNameKey(item.name) === wanted && item.status !== 'ALREADY');
   if (here.length + inFile.length > 1) { result.problems.push(`More than one dispatcher is called “${text(row.supports)}”. Use Add one person for ${result.supportType === 'UPDATER' ? 'this updater' : 'this support'} and choose their dispatcher from the list.`); result.status = 'PROBLEM'; }
   else if (here[0]?.leaving) { result.problems.push(`“${text(row.supports)}” is leaving. Choose another dispatcher.`); result.status = 'PROBLEM'; }
   else if (here[0]) result.supportsMemberId = here[0].id;
   else if (inFile[0]?.status === 'READY') result.supportsRow = inFile[0].row;
   else if (inFile[0]) { result.problems.push(`“${text(row.supports)}” in row ${inFile[0].row} isn’t ready yet.`); if (result.status === 'READY') result.status = 'CHOICE'; }
   else { result.problems.push(`${result.supportType === 'UPDATER' ? 'Assists' : 'Supports'} “${text(row.supports)}”, who isn’t in this file or the workspace.`); result.status = 'PROBLEM'; }
  });
  // A sign-in used by someone else here or in this file. Allowed, and worth saying before anything is saved. A row that won't be added, or someone who left, shares nothing.
  const signInsOf = (row: ExistingRowDto) => [text(row.datEmail).toLowerCase(), text(row.truckstopEmail).toLowerCase()].filter(Boolean);
  const timesInFile = new Map<string, number>();
  rows.forEach((row, index) => { if (['READY', 'CHOICE'].includes(results[index].status) && !results[index].left) for (const email of new Set(signInsOf(row))) timesInFile.set(email, (timesInFile.get(email) ?? 0) + 1); });
  rows.forEach((row, index) => { results[index].sharesSignIn = !results[index].left && signInsOf(row).some(email => signIns.has(email) || (timesInFile.get(email) ?? 0) > 1); });
  return { results, choices: [...choices.values()] };
 }
 async check(rows: ExistingRowDto[]) {
  const { results, choices } = this.evaluate(rows, await this.known(this.db.manager), await signInsInUse(this.db.manager));
  return { rows: results.map(({ row, name, position, supportType, status, problems, sameName, left, leftOn, hasAccounts, match }) => ({ row, name, position, supportType, status, problems, sameName, left, leftOn, hasAccounts,
   match: match && { id: match.id, name: match.name, status: match.status, why: match.why, options: match.options, fills: match.fills.map(fill => fill.startsWith('otherNames:') ? `${fill.slice(11)} other ${fill.slice(11) === '1' ? 'name' : 'names'}` : FIELD_LABELS[fill] ?? fill) } })),
   choices, counts: this.counts(results) };
 }
 private counts(results: RowResult[]) {
  const count = (status: RowStatus) => results.filter(row => row.status === status).length;
  const ready = results.filter(row => row.status === 'READY');
  return { ready: count('READY'), choice: count('CHOICE'), problem: count('PROBLEM'), already: count('ALREADY'), noStartDate: ready.filter(row => !row.startedOn).length, noMc: ready.filter(row => row.noMc && !row.left).length, mcFromTeam: ready.filter(row => row.mcFromTeam).length, wholeTeam: ready.filter(row => row.supportsTeamId).length, sharedSignIn: ready.filter(row => row.sharesSignIn).length,
   left: ready.filter(row => row.left).length, noLastDay: ready.filter(row => row.left && !row.leftOn).length, askIt: ready.filter(row => row.askIt).length, cameBack: ready.filter(row => row.previousMemberId).length, fill: results.filter(row => row.fill).length };
 }
 /** Adds the rows that are ready and fills in the ones chosen for it, checked again under one lock so two uploads can't both add the same person. */
 async add(user: User, rows: ExistingRowDto[], sourceName?: string) {
  await onboardingLimit(this.db, 'existing-add:' + user.id, 60, 3600);
  const alerts: string[] = [];
  const result = await this.db.transaction(async em => {
   await em.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK]);
   const known = await this.known(em), { results } = this.evaluate(rows, known, await signInsInUse(em));
   const ready = results.filter(row => row.status === 'READY'), byRow = new Map(rows.map(row => [row.row, row])), added = new Map<number, string>();
   const locked = new Map<string, Team>(), today = usDay('latest');
   // Read FOR SHARE and checked again, members before teams: leaving doesn't take the import lock, and refuses while supports are linked.
   for (const id of [...new Set(ready.flatMap(row => row.supportsMemberId ?? []))].sort()) await supportedDispatcher(em, id);
   // Dispatchers first: a support in the same file links to them.
   for (const result of [...ready.filter(row => row.position === 'DISPATCHER'), ...ready.filter(row => row.position === 'SUPPORT')]) {
    // With no start date, joinedAt and any first period keep the day they were added (or their last day, for someone who left), marked as not recorded so it never shows as real.
    const row = byRow.get(result.row)!, startedAt = midday(result.startedOn ?? result.leftOn ?? today), hasPeriod = result.position === 'SUPPORT' ? !result.left : !result.noMc && !!result.mcId;
    const leftAt = result.left ? midday(result.leftOn ?? today) : null;
    const placedIn = result.left ? null : result.teamId ?? result.supportsTeamId;
    if (placedIn && !locked.has(placedIn)) {
     const team = await lockTeam(em, placedIn);
     if (!team || team.archivedAt || (result.teamId && team.mcId !== result.mcId)) throw new ConflictException('A team changed while this was being added. Check the rows again.');
     locked.set(placedIn, team);
    }
    const [first, ...rest] = result.name.split(' ');
    const member = await em.getRepository(DispatchMember).save({ applicationId: null, firstName: text(row.firstName) || first, lastName: text(row.lastName) || rest.join(' '), position: result.position, supportType: result.supportType,
     status: result.left ? 'LEFT' : 'ACTIVE', jobTitleId: result.jobTitleId, joinedAt: startedAt, leftAt, leftReason: result.left ? text(row.leftReason) || null : null, previousMemberId: result.previousMemberId });
    if (result.position === 'DISPATCHER') { if (hasPeriod) await em.getRepository(MemberAssignment).save({ memberId: member.id, mcId: result.mcId, teamId: result.teamId, startedAt, endedAt: leftAt, reason: 'Added as an existing dispatcher.', actorId: user.id }); }
    else if (!result.left) {
     const dispatcherId = result.supportsTeamId ? null : result.supportsMemberId ?? added.get(result.supportsRow!) ?? null;
     if (!dispatcherId && !result.supportsTeamId) throw new ConflictException('A dispatcher changed while this was being added. Check the rows again.');
     await em.getRepository(MemberSupportLink).save({ supportId: member.id, dispatcherId, teamId: result.supportsTeamId, startedAt, reason: result.supportType === 'UPDATER' ? 'Added as an existing updater.' : 'Added as an existing support.', actorId: user.id });
    }
    const record = await em.getRepository(ExistingMemberRecord).save({ memberId: member.id, addedBy: user.id, sourceName: sourceName?.trim().slice(0, 200) || null,
     companyEmail: text(row.companyEmail).toLowerCase() || null, ringCentralNumber: text(row.ringCentralNumber) || null, personalEmail: text(row.personalEmail).toLowerCase() || null, personalPhone: text(row.personalPhone) || null,
     telegram: telegramUsername(text(row.telegram)), ringCentralExtension: text(row.ringCentralExtension) || null, datEmail: text(row.datEmail).toLowerCase() || null, truckstopEmail: text(row.truckstopEmail).toLowerCase() || null,
     startDateKnown: !!result.startedOn, periodDateKnown: !!result.startedOn || !hasPeriod, leftDateKnown: !result.left || !!result.leftOn,
     legalFirstName: text(row.legalFirstName) || null, legalLastName: text(row.legalLastName) || null });
    for (const otherName of result.otherNames.filter(item => listNameKey(item) !== listNameKey(result.name))) await em.getRepository(MemberOtherName).save({ memberId: member.id, name: otherName, mcId: null, addedBy: user.id });
    let paper = 0;
    for (const [kind, value] of [['NDA', text(row.ndaSignedOn)], ['SOP', text(row.sopSignedOn)]] as const) {
     if (!value) continue;
     await em.getRepository(MemberPaperDocument).save({ memberId: member.id, kind, signedOn: fileDate(value)!, recordedBy: user.id }); paper += 1;
    }
    await em.getRepository(DispatchEvent).save({ memberId: member.id, teamId: null, event: 'EXISTING_ADDED', actorId: user.id, metadata: { source: sourceName ? 'file' : 'form', paper, noStartDate: !result.startedOn, noMc: result.noMc,
     ...(result.left ? { left: true, noLastDay: !result.leftOn, askIt: result.askIt } : {}), ...(result.previousMemberId ? { cameBack: true } : {}) } });
    // Someone who left whose accounts may still be open: IT closes what the row records, due today. Nothing is sent to the person.
    if (result.askIt) alerts.push(...await this.askItToClose(em, user, member, record, 'SUSPEND', null));
    added.set(result.row, member.id);
   }
   let filled = 0;
   for (const result of results.filter(row => row.fill)) { await this.fillIn(em, user, byRow.get(result.row)!, result); filled += 1; }
   return { added: added.size, filled, members: [...added.entries()].map(([row, id]) => ({ row, id })),
    left: results.filter(row => row.status !== 'READY' && !row.fill).map(({ row, name, status, problems, sameName }) => ({ row, name, status, problems, sameName })) };
  });
  this.alerts.dispatch(alerts);
  return result;
 }
 /** Fills only what a recorded person's record is missing, from a row that matched them. A value already recorded never changes here. */
 private async fillIn(em: EntityManager, user: User, row: ExistingRowDto, result: RowResult) {
  const match = result.match!;
  const member = await em.getRepository(DispatchMember).findOne({ where: { id: match.id }, lock: { mode: 'pessimistic_write' } });
  const record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId: match.id });
  if (!member || !record) throw new ConflictException('A record changed while this was being added. Check the rows again.');
  const fields: string[] = [];
  const values: Record<(typeof accountFields)[number], string | null> = { companyEmail: text(row.companyEmail).toLowerCase() || null, ringCentralNumber: text(row.ringCentralNumber) || null, ringCentralExtension: text(row.ringCentralExtension) || null,
   personalEmail: text(row.personalEmail).toLowerCase() || null, personalPhone: text(row.personalPhone) || null, telegram: telegramUsername(text(row.telegram)), datEmail: text(row.datEmail).toLowerCase() || null, truckstopEmail: text(row.truckstopEmail).toLowerCase() || null };
  for (const field of accountFields) if (match.fills.includes(field) && !record[field] && values[field]) { record[field] = values[field]; fields.push(field); }
  if (match.fills.includes('legalName') && !record.legalFirstName && !record.legalLastName) { record.legalFirstName = text(row.legalFirstName) || null; record.legalLastName = text(row.legalLastName) || null; fields.push('legalName'); }
  if (match.fills.includes('lastDay') && !record.leftDateKnown && result.leftOn && member.status === 'LEFT') {
   const leftAt = midday(result.leftOn);
   // The period that ended on the day they were added ends on their real last day, never before it began.
   const period = await em.getRepository(MemberAssignment).findOne({ where: { memberId: member.id }, order: { startedAt: 'DESC', createdAt: 'DESC' } });
   if (period && period.startedAt <= leftAt) { period.endedAt = leftAt; await em.save(period); }
   member.leftAt = leftAt; record.leftDateKnown = true; fields.push('lastDay');
   if (!member.leftReason && text(row.leftReason)) { member.leftReason = text(row.leftReason); fields.push('leftReason'); }
  }
  const have = new Set((await em.getRepository(MemberOtherName).findBy({ memberId: member.id })).map(item => item.name.toLowerCase()));
  const newNames = result.otherNames.filter(item => !have.has(item.toLowerCase()) && listNameKey(item) !== listNameKey(`${member.firstName} ${member.lastName}`));
  for (const otherName of newNames) await em.getRepository(MemberOtherName).save({ memberId: member.id, name: otherName, mcId: null, addedBy: user.id });
  if (newNames.length) fields.push('otherNames');
  if (!fields.length) return;
  member.version += 1; await em.save(member); await em.save(record);
  await em.getRepository(DispatchEvent).save({ memberId: member.id, teamId: null, event: 'EXISTING_UPDATED', actorId: user.id, metadata: { fields, from: 'file' } });
 }
 /**
  * IT closes the accounts recorded for someone added as Left: a removal checklist due today from what the manager recorded,
  * and IT's usual alert. Returns the alerts to send after the transaction.
  */
 async askItToClose(em: EntityManager, user: User, member: DispatchMember, record: ExistingMemberRecord, emailAfter: 'FORWARD' | 'SUSPEND', note: string | null) {
  const { companyEmail, ringCentralNumber, ringCentralExtension, datEmail, truckstopEmail } = record;
  const accounts = { companyEmail, ringCentralNumber, ringCentralExtension, datEmail, truckstopEmail };
  const alerts = await createRemoval(em, this.alerts, { setup: null, taskKeys: await removalTaskKeys(em, member.position, [], accounts), accounts, position: positionLabel(member), memberId: member.id, name: `${member.firstName} ${member.lastName}`,
   dueOn: usDay('latest'), scheduled: false, emailAfter, actorId: user.id, ...await lastPlace(em, member.id) });
  if (note) await em.query(`UPDATE it_removal_requests SET note = $2 WHERE "memberId" = $1 AND "cancelledAt" IS NULL`, [member.id, note]);
  return alerts;
 }
 /** Everyone added by hand who hasn't left, with what is outstanding. */
 async paperwork(user: User) {
  const rows: { id: string; firstName: string; lastName: string; position: string; supportType: string; mc: string | null; team: string | null; wholeTeam: string | null; dispatcher: string | null; personalEmail: string | null; acceptedAt: Date | null;
   paper: { kind: string; signedOn: string }[]; signed: string[]; invitationId: string | null; expiresAt: Date | null; openedAt: Date | null; consumedAt: Date | null; applicationId: string | null; applicationStatus: string | null; managerId: string | null; accessUntil: Date | null; returnEmail: string | null }[] = await this.db.query(`
   SELECT d.id, d."firstName", d."lastName", d.position, d."supportType", CASE WHEN st.id IS NOT NULL THEN sm.name WHEN x."mcId" IS NULL THEN '${NO_MC}' ELSE m.name END AS mc, coalesce(st.name, t.name) AS team, st.name AS "wholeTeam", CASE WHEN sd.id IS NULL THEN NULL ELSE sd."firstName" || ' ' || sd."lastName" END AS dispatcher, r."personalEmail", r."acceptedAt",
    coalesce((SELECT json_agg(json_build_object('kind', p.kind, 'signedOn', p."signedOn"::text)) FROM member_paper_documents p WHERE p."memberId" = d.id), '[]') AS paper,
    coalesce((SELECT json_agg(DISTINCT c.kind) FROM document_signatures s JOIN company_documents c ON c.id = s."documentId" WHERE s."applicationId" = a.id AND s."signerRole" = 'APPLICANT'), '[]') AS signed,
    i.id AS "invitationId", i."expiresAt", i."openedAt", i."consumedAt", a.id AS "applicationId", a.status AS "applicationStatus", a."assignedManagerId" AS "managerId", a."applicantAccessUntil" AS "accessUntil", i.email AS "returnEmail"
   FROM existing_member_records r JOIN dispatch_members d ON d.id = r."memberId"
   LEFT JOIN LATERAL (SELECT * FROM member_support_links l WHERE l."supportId" = d.id AND l."endedAt" IS NULL LIMIT 1) sl ON true LEFT JOIN dispatch_members sd ON sd.id = sl."dispatcherId" LEFT JOIN teams st ON st.id = sl."teamId" LEFT JOIN mcs sm ON sm.id = st."mcId"
   LEFT JOIN LATERAL (SELECT * FROM member_assignments x WHERE x."memberId" = coalesce(sl."dispatcherId", d.id) AND x."endedAt" IS NULL LIMIT 1) x ON true LEFT JOIN mcs m ON m.id = x."mcId" LEFT JOIN teams t ON t.id = x."teamId"
   LEFT JOIN LATERAL (SELECT * FROM invitations v WHERE v."catchUpMemberId" = d.id AND v."revokedAt" IS NULL ORDER BY v."createdAt" DESC LIMIT 1) i ON true LEFT JOIN dispatcher_applications a ON a."invitationId" = i.id
   WHERE d.status <> 'LEFT' ORDER BY lower(d."firstName"), lower(d."lastName") LIMIT 1000`);
  const items = rows.map(row => {
   const canReview = !!row.managerId && (user.role === Role.SYSTEM_ADMIN || row.managerId === user.id);
   const expired = !row.consumedAt && !!row.expiresAt && row.expiresAt.getTime() < Date.now();
   const timeEnded = !!row.accessUntil && !!row.applicationStatus && paperworkTimeEnded({ consumedAt: row.consumedAt, status: row.applicationStatus, applicantAccessUntil: row.accessUntil });
   const state = row.acceptedAt ? 'FINISHED' : !row.invitationId || expired ? (row.personalEmail ? 'TO_CREATE' : 'NO_EMAIL') : !row.consumedAt ? (row.openedAt ? 'OPENED' : 'SENT') : timeEnded ? 'TIME_ENDED'
    : ['SUBMITTED', 'RESUBMITTED'].includes(row.applicationStatus ?? '') ? 'WAITING' : row.applicationStatus === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : 'IN_PROGRESS';
   return { id: row.id, firstName: row.firstName, lastName: row.lastName, position: row.position, supportType: row.supportType, mc: row.mc, team: row.team, wholeTeam: row.wholeTeam, dispatcher: row.dispatcher, personalEmail: row.personalEmail, state, linkExpired: expired,
    linkExpiresAt: row.expiresAt, nda: this.docState('NDA', row), sop: this.docState('SOP', row), applicationId: row.consumedAt && canReview ? row.applicationId : null, canReview,
    timeEndedAt: timeEnded ? row.accessUntil : null, returnEmail: row.consumedAt && canReview ? row.returnEmail : null };
  });
  const count = (...states: string[]) => items.filter(item => states.includes(item.state)).length;
  return { items, counts: { toCreate: count('TO_CREATE', 'NO_EMAIL'), sent: count('SENT', 'OPENED', 'IN_PROGRESS', 'CHANGES_REQUESTED', 'TIME_ENDED'), waiting: count('WAITING'), finished: count('FINISHED') } };
 }
 private docState(kind: string, row: { paper: { kind: string; signedOn: string }[]; signed: string[] }) {
  const paper = row.paper.find(item => item.kind === kind);
  return paper ? { state: 'PAPER', signedOn: paper.signedOn } : { state: row.signed.includes(kind) ? 'SIGNED' : 'TO_SIGN', signedOn: null };
 }
 /**
  * Links for the manager to send, shown once. Each needs the personal email on the record and lasts 14 days; a new link
  * stops an unused earlier one. Someone who has already started keeps going with their reference and a fresh code.
  */
 async links(user: User, memberIds: string[]) {
  await onboardingLimit(this.db, 'catch-up-links:' + user.id, 30, 3600);
  const origin = webOrigins({ WEB_ORIGIN: this.config.getOrThrow<string>('WEB_ORIGIN') })[0];
  return { items: await this.db.transaction(async em => {
   const results: { memberId: string; name: string; email?: string; url?: string; problem?: string }[] = [];
   for (const memberId of [...new Set(memberIds)].sort()) {
    await lockCatchUpLinks(em, memberId);
    const member = await em.getRepository(DispatchMember).findOne({ where: { id: memberId }, lock: { mode: 'pessimistic_write' } });
    const record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId });
    if (!member || !record) throw new NotFoundException('This dispatcher record no longer exists.');
    const name = `${member.firstName} ${member.lastName}`, refuse = (problem: string) => results.push({ memberId, name, problem });
    if (member.status === 'LEFT') { refuse('They have left.'); continue; }
    if (record.acceptedAt) { refuse('Their paperwork is finished.'); continue; }
    if (!record.personalEmail) { refuse('Add their personal email first.'); continue; }
    const open = await em.getRepository(Invitation).find({ where: { catchUpMemberId: memberId, revokedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
    if (open.some(item => item.consumedAt)) { refuse('They’ve already started. Give them their reference from their page.'); continue; }
    // A link in use belongs to the manager who sent it: whoever replaces it becomes responsible, and sees their ID selfie.
    if (user.role !== Role.SYSTEM_ADMIN && open.some(item => item.managerId !== user.id && item.expiresAt > new Date())) { refuse('Another manager has sent their link. Ask that manager or an administrator.'); continue; }
    for (const earlier of open) { earlier.revokedAt = new Date(); await em.save(earlier); await em.getRepository(ApplicationActivity).save({ invitationId: earlier.id, event: 'INVITATION_REVOKED', actorId: user.id }); }
    const token = randomBytes(32).toString('hex'), expiresAt = new Date(Date.now() + LINK_DAYS * 86400000);
    const invitation = await em.getRepository(Invitation).save({ email: null, expectedEmail: record.personalEmail, mcName: null, teamLead: null, jobTitle: null, position: member.position, supportType: member.supportType, supportsMemberId: null,
     catchUpMemberId: memberId, telegramRequired: false, managerId: user.id, tokenHash: digest(token), expiresAt });
    await em.getRepository(DispatcherApplication).save({ invitationId: invitation.id, assignedManagerId: user.id, status: 'INVITED', applicantAccessUntil: expiresAt,
     fields: { preferredAmericanFirstName: member.firstName, preferredAmericanLastName: member.lastName, ...(record.personalPhone ? { personalPhoneNumber: record.personalPhone } : {}), ...(record.telegram ? { telegram: record.telegram } : {}) } });
    await em.getRepository(ApplicationActivity).save({ invitationId: invitation.id, event: 'INVITATION_CREATED', actorId: user.id });
    await em.getRepository(DispatchEvent).save({ memberId, teamId: null, event: 'CATCH_UP_LINK_CREATED', actorId: user.id, metadata: { replaced: open.length > 0 } });
    results.push({ memberId, name, email: record.personalEmail, url: `${origin}/apply#${token}` });
   }
   return results;
  }) };
 }
 /**
  * Someone who started and ran out of time, before sending it or while correcting it: their manager or an administrator
  * gives them another 14 days from now. Only once the time has ended, as often as it's needed; nothing they did changes,
  * and the manager tells them, because the workspace doesn't message them. The application history records it.
  */
 async moreTime(user: User, memberId: string) {
  await onboardingLimit(this.db, 'catch-up-time:' + user.id, 30, 3600);
  return this.db.transaction(async em => {
   await lockCatchUpLinks(em, memberId);
   const member = await em.getRepository(DispatchMember).findOne({ where: { id: memberId }, lock: { mode: 'pessimistic_write' } });
   const record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId });
   if (!member || !record) throw new NotFoundException('This dispatcher record no longer exists.');
   if (member.status === 'LEFT') throw new ConflictException('This person has left, so their paperwork is closed.');
   const link = await em.getRepository(Invitation).findOneBy({ catchUpMemberId: memberId, revokedAt: IsNull(), consumedAt: Not(IsNull()) });
   const application = link && await em.getRepository(DispatcherApplication).findOneBy({ invitationId: link.id });
   if (!link || !application) throw new ConflictException('They haven’t started their paperwork.');
   if (user.role !== Role.SYSTEM_ADMIN && application.assignedManagerId !== user.id) throw new ForbiddenException('Only their manager or an administrator can give them more time.');
   if (!paperworkTimeEnded({ consumedAt: link.consumedAt, status: application.status, applicantAccessUntil: application.applicantAccessUntil })) throw new ConflictException('Their time hasn’t ended, or they have nothing left to do.');
   application.applicantAccessUntil = new Date(Date.now() + LINK_DAYS * 86400000);
   await em.save(application);
   await em.getRepository(ApplicationActivity).save({ invitationId: link.id, event: 'ACCESS_EXTENDED', actorId: user.id });
   return { id: memberId, accessUntil: application.applicantAccessUntil };
  });
 }
 /**
  * Corrects what a manager recorded. Send only what changed; '' clears a value. A paper date can't be added once the document
  * was signed here. A corrected personal email moves an unused link with it, and corrected accounts reach IT's open removal.
  */
 async update(user: User, id: string, dto: UpdateExistingDto) {
  let alerts: string[] = [];
  const result = await this.db.transaction(async em => {
   await em.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK]);
   await lockCatchUpLinks(em, id);
   const member = await em.getRepository(DispatchMember).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   const record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId: id });
   if (!member || !record) throw new NotFoundException('This dispatcher record no longer exists.');
   if (member.version !== dto.version) throw new ConflictException('Someone else changed this record. Reload and try again.');
   if (member.status === 'LEFT') throw new ConflictException('This dispatcher has left; their record is kept for history.');
   const known = await this.known(em), changed: string[] = [];
   const set = (field: 'companyEmail' | 'ringCentralNumber' | 'personalEmail' | 'personalPhone' | 'telegram' | 'ringCentralExtension' | 'datEmail' | 'truckstopEmail', value: string | undefined) => { if (value !== undefined && value !== (record[field] ?? '')) { record[field] = value || null; changed.push(field); } };
   for (const [field, used, label] of [['companyEmail', known.companyEmails, 'company email'], ['personalEmail', known.personalEmails, 'personal email']] as const) {
    const value = dto[field]?.toLowerCase();
    if (value && this.fictionalOnly && !value.endsWith('@example.test')) throw new BadRequestException(`Outside production, the ${label} must be a fictional example.test address.`);
    if (value && ExistingDispatchersService.usedByCurrent(known, used, value, id)) throw new ConflictException(`Someone in the workspace already has this ${label}.`);
    set(field, value);
   }
   if (dto.personalPhone && ExistingDispatchersService.usedByCurrent(known, known.phones, digits(dto.personalPhone), id)) throw new ConflictException('Someone in the workspace already has this personal phone.');
   set('ringCentralNumber', dto.ringCentralNumber); set('personalPhone', dto.personalPhone);
   if (dto.telegram && !telegramUsername(dto.telegram)) throw new BadRequestException('Telegram should be a username, like @alexmoreno.');
   set('telegram', dto.telegram && telegramUsername(dto.telegram)!); set('ringCentralExtension', dto.ringCentralExtension);
   // A sign-in may be shared, so unlike the other emails it's never refused for being on someone else's record.
   for (const [field, label] of [['datEmail', 'DAT'], ['truckstopEmail', 'Truckstop']] as const) {
    const value = dto[field]?.toLowerCase();
    if (value && this.fictionalOnly && !value.endsWith('@example.test')) throw new BadRequestException(`Outside production, the ${label} sign-in must be a fictional example.test address.`);
    set(field, value);
   }
   const signed: { kind: string }[] = dto.ndaSignedOn === undefined && dto.sopSignedOn === undefined ? [] : await em.query(`SELECT DISTINCT c.kind FROM invitations i JOIN dispatcher_applications a ON a."invitationId" = i.id
     JOIN document_signatures s ON s."applicationId" = a.id AND s."signerRole" = 'APPLICANT' JOIN company_documents c ON c.id = s."documentId" WHERE i."catchUpMemberId" = $1`, [id]);
   for (const [kind, value] of [['NDA', dto.ndaSignedOn], ['SOP', dto.sopSignedOn]] as const) {
    if (value === undefined) continue;
    const existing = await em.getRepository(MemberPaperDocument).findOneBy({ memberId: id, kind });
    if (!value) {
     if (!existing) continue;
     // A scan of the paper copy belongs to this record, so the record stays while one is on file.
     const [scan] = await em.query(`SELECT 1 FROM member_paper_scans WHERE "memberId" = $1 AND kind = $2 LIMIT 1`, [id, kind]);
     if (scan) throw new ConflictException(`A scan of the paper ${kind} is on file, so its date can’t be cleared.`);
     await em.remove(existing); changed.push(kind); continue;
    }
    if (value > usDay('latest')) throw new BadRequestException(`The ${kind} date can’t be in the future.`);
    if (signed.some(row => row.kind === kind)) throw new ConflictException(`They already signed the ${kind} in the workspace.`);
    if (existing?.signedOn === value) continue;
    await em.getRepository(MemberPaperDocument).save({ ...(existing ?? { memberId: id, kind }), signedOn: value, recordedBy: user.id }); changed.push(kind);
   }
   if (!changed.length) return { id, version: member.version };
   member.version += 1; await em.save(member); await em.save(record);
   if (changed.includes('personalEmail')) await this.moveUnusedLink(em, user, id, record.personalEmail);
   const accounts = changed.filter(field => ['companyEmail', 'ringCentralNumber', 'ringCentralExtension', 'datEmail', 'truckstopEmail'].includes(field));
   if (accounts.length) alerts = await this.correctRemoval(em, user, member, record, accounts);
   await em.getRepository(DispatchEvent).save({ memberId: id, teamId: null, event: 'EXISTING_UPDATED', actorId: user.id, metadata: { fields: changed } });
   return { id, version: member.version };
  });
  this.alerts.dispatch(alerts);
  return result;
 }
 /** An unused link works only with the email on the record: it follows a correction, and stops when the email is cleared. */
 private async moveUnusedLink(em: EntityManager, user: User, memberId: string, email: string | null) {
  for (const link of await em.getRepository(Invitation).findBy({ catchUpMemberId: memberId, revokedAt: IsNull(), consumedAt: IsNull() })) {
   if (email) { link.expectedEmail = email; await em.save(link); continue; }
   link.revokedAt = new Date(); await em.save(link);
   await em.getRepository(ApplicationActivity).save({ invitationId: link.id, event: 'INVITATION_REVOKED', actorId: user.id });
  }
 }
 /**
  * IT's removal copied the recorded accounts when the notice was recorded, so a correction during the notice goes there too.
  * A support who had no accounts then gets their removal now. A step IT already finished opens again for a new account.
  */
 private async correctRemoval(em: EntityManager, user: User, member: DispatchMember, record: ExistingMemberRecord, fields: string[]) {
  const removal = await em.getRepository(ItRemovalRequest).findOne({ where: { memberId: member.id, cancelledAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
  const { companyEmail, ringCentralNumber, ringCentralExtension, datEmail, truckstopEmail } = record;
  if (!removal) {
   const notice = await em.getRepository(MemberNotice).findOneBy({ memberId: member.id, cancelledAt: IsNull(), finishedAt: IsNull() });
   if (!notice || (!companyEmail && !ringCentralNumber && !datEmail && !truckstopEmail)) return [];
   return createRemoval(em, this.alerts, { setup: null, taskKeys: await removalTaskKeys(em, member.position, [], { companyEmail, ringCentralNumber, datEmail, truckstopEmail }), accounts: { companyEmail, ringCentralNumber, ringCentralExtension, datEmail, truckstopEmail }, position: positionLabel(member), memberId: member.id, name: `${member.firstName} ${member.lastName}`, dueOn: notice.lastDay, scheduled: true, emailAfter: 'SUSPEND', actorId: user.id, ...await memberPlace(em, member.id) });
  }
  // Someone with IT setup: what IT recorded on any of their setups comes first, so a correction only reaches IT where IT recorded nothing.
  const setups = await memberSetups(em, member.id, removal.setupRequestId), fromIt = setupAccounts(setups);
  const next: Record<string, string | null> = { companyEmail: fromIt.companyEmail ?? companyEmail, ringCentralNumber: fromIt.ringCentralNumber ?? ringCentralNumber, ringCentralExtension: fromIt.ringCentralExtension ?? ringCentralExtension, datEmail: fromIt.datEmail ?? datEmail, truckstopEmail: fromIt.truckstopEmail ?? truckstopEmail };
  const profile = removal.profile as unknown as Record<string, string | null | undefined>, changed = fields.filter(field => (profile[field] ?? null) !== next[field]);
  if (!changed.length) return [];
  if (removal.completedAt) throw new ConflictException('IT has already finished removing their access. Tell IT about this account directly.');
  removal.profile = { ...removal.profile, ...next };
  // Forwarding needs a mailbox, and what happens to a number is decided for that number.
  if (!next.companyEmail) { removal.emailAfter = 'SUSPEND'; removal.forwardTo = null; }
  if (changed.includes('ringCentralNumber')) removal.numberOutcome = null;
  removal.version += 1; await em.save(removal);
  const steps = [...(changed.includes('companyEmail') && next.companyEmail ? ['GOOGLE_WORKSPACE'] : []), ...(changed.includes('ringCentralNumber') && next.ringCentralNumber ? ['RINGCENTRAL'] : []),
   ...((changed.includes('datEmail') && next.datEmail) || (changed.includes('truckstopEmail') && next.truckstopEmail) ? ['BUSINESS_SOFTWARE'] : [])];
  let reopened = false;
  // A support's removal lists only what they had: a new account adds its step.
  const present = new Set((await em.getRepository(ItRemovalTask).findBy({ requestId: removal.id })).map(task => task.key));
  const added = steps.filter(key => !present.has(key));
  if (added.length) await em.getRepository(ItRemovalTask).save(added.map(key => ({ requestId: removal.id, key, status: 'PENDING' as const, notes: '' })));
  for (const task of steps.length ? await em.getRepository(ItRemovalTask).find({ where: { requestId: removal.id, key: In(steps), status: 'COMPLETED' } }) : []) {
   task.status = 'PENDING'; task.updatedBy = user.id; await em.save(task); reopened = true;
  }
  await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId: user.id, event: 'ACCOUNTS_CORRECTED', metadata: { reopened, added: added.length > 0 } });
  return [];
 }
 private async lockRecord(em: EntityManager, id: string, version: number) {
  const member = await em.getRepository(DispatchMember).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
  if (member.version !== version) throw new ConflictException('Someone else changed this record. Reload and try again.');
  return { member, record: await em.getRepository(ExistingMemberRecord).findOneBy({ memberId: id }) };
 }
 /**
  * The last day of someone added as Left without one (section 33). Their last MC and team period ends on it. A start or
  * period that only held the day they were added moves back to it; a recorded one can't come after it.
  */
 async recordLeftDay(user: User, id: string, dto: LeftDayDto) {
  return this.db.transaction(async em => {
   const { member, record } = await this.lockRecord(em, id, dto.version);
   if (!record || member.status !== 'LEFT' || record.leftDateKnown) throw new ConflictException('Their last day is already recorded.');
   if (dto.leftOn > usDay('latest')) throw new BadRequestException('The last day can’t be in the future.');
   const leftAt = midday(dto.leftOn);
   if (leftAt < member.joinedAt) {
    if (record.startDateKnown) throw new BadRequestException('The last day can’t be before they started.');
    member.joinedAt = leftAt;
   }
   const period = await em.getRepository(MemberAssignment).findOne({ where: { memberId: id }, order: { startedAt: 'DESC', createdAt: 'DESC' } });
   if (period) {
    if (period.startedAt > leftAt && !record.periodDateKnown) period.startedAt = leftAt;
    if (period.startedAt > leftAt) throw new BadRequestException('The last day can’t be before their last MC and team began.');
    period.endedAt = leftAt; await em.save(period);
   }
   const reasonChanged = !!dto.reason && dto.reason !== (member.leftReason ?? '');
   member.leftAt = leftAt; if (reasonChanged) member.leftReason = dto.reason!;
   member.version += 1; record.leftDateKnown = true;
   await em.save(member); await em.save(record);
   await em.getRepository(DispatchEvent).save({ memberId: id, teamId: null, event: 'LEFT_DAY_RECORDED', actorId: user.id, metadata: { reasonChanged } });
   return { id, version: member.version };
  });
 }
 /**
  * Someone added as Left whose accounts may still be open (section 33): IT gets a removal checklist from what the manager
  * recorded, due today, and the asker a portal notice when it's done. Nothing is sent to the person.
  */
 async closeAccounts(user: User, id: string, dto: CloseAccountsDto) {
  const alerts: string[] = [];
  const result = await this.db.transaction(async em => {
   const { member, record } = await this.lockRecord(em, id, dto.version);
   if (member.status !== 'LEFT' || !record) throw new ConflictException('Only someone added by hand as Left is asked for here. For someone leaving now, use Mark as leaving.');
   if (await em.getRepository(ItRemovalRequest).existsBy({ memberId: id, cancelledAt: IsNull() })) throw new ConflictException('IT has already been asked to close their accounts.');
   if (!record.companyEmail && !record.ringCentralNumber && !record.datEmail && !record.truckstopEmail) throw new BadRequestException('No accounts are recorded for them, so there is nothing for IT to close.');
   alerts.push(...await this.askItToClose(em, user, member, record, dto.emailAfter, dto.note || null));
   member.version += 1; await em.save(member);
   await em.getRepository(DispatchEvent).save({ memberId: id, teamId: null, event: 'CLOSE_ACCOUNTS_ASKED', actorId: user.id, metadata: { forward: dto.emailAfter === 'FORWARD' && !!record.companyEmail, note: !!dto.note } });
   return { id, version: member.version };
  });
  this.alerts.dispatch(alerts);
  return result;
 }
 /**
  * Names (section 33): the legal name of someone added by hand ('' clears it) and the whole list of other names, each with
  * the MC where it was used when known. Someone who came through onboarding keeps their application's legal name, which only
  * an administrator corrects, with a reason. Works for people who left too.
  */
 async setNames(user: User, id: string, dto: MemberNamesDto) {
  return this.db.transaction(async em => {
   const { member, record } = await this.lockRecord(em, id, dto.version);
   const fields: string[] = [];
   if (dto.legalFirstName !== undefined || dto.legalLastName !== undefined) {
    const first = dto.legalFirstName === undefined ? record?.legalFirstName ?? null : dto.legalFirstName || null, last = dto.legalLastName === undefined ? record?.legalLastName ?? null : dto.legalLastName || null;
    if (!record) { if (first || last) throw new BadRequestException('Their legal name comes from their application. An administrator changes it with Correct details, with a reason.'); }
    else if (first !== record.legalFirstName || last !== record.legalLastName) { record.legalFirstName = first; record.legalLastName = last; await em.save(record); fields.push('legalName'); }
   }
   const own = listNameKey(`${member.firstName} ${member.lastName}`), wanted: { name: string; mcId: string | null }[] = [];
   for (const item of dto.otherNames) {
    const name = item.name.replace(/\s+/g, ' ').trim();
    if (listNameKey(name) === own || wanted.some(other => listNameKey(other.name) === listNameKey(name))) continue;
    wanted.push({ name, mcId: item.mcId ?? null });
   }
   const mcIds = [...new Set(wanted.flatMap(item => item.mcId ?? []))];
   if (mcIds.length && (await em.query(`SELECT count(*)::integer AS n FROM mcs WHERE id = ANY($1)`, [mcIds]))[0].n !== mcIds.length) throw new BadRequestException('Choose an MC from the list.');
   const current = await em.getRepository(MemberOtherName).find({ where: { memberId: id }, order: { createdAt: 'ASC' } });
   const sameList = current.length === wanted.length && current.every((item, index) => item.name === wanted[index].name && item.mcId === wanted[index].mcId);
   if (!sameList) {
    if (current.length) await em.getRepository(MemberOtherName).delete({ memberId: id });
    for (const item of wanted) await em.getRepository(MemberOtherName).save({ memberId: id, name: item.name, mcId: item.mcId, addedBy: user.id });
    fields.push('otherNames');
   }
   if (!fields.length) return { id, version: member.version };
   member.version += 1; await em.save(member);
   await em.getRepository(DispatchEvent).save({ memberId: id, teamId: null, event: 'NAMES_CHANGED', actorId: user.id, metadata: { fields } });
   return { id, version: member.version };
  });
 }
}

/** In the decision transaction: the paperwork is finished, and the dispatcher's page now reads from this application. Their job, MC and team don't change. */
export async function acceptPaperwork(em: EntityManager, memberId: string, applicationId: string, fields: { preferredAmericanFirstName?: string; preferredAmericanLastName?: string }, actorId: string, at: Date) {
 const member = await em.getRepository(DispatchMember).findOne({ where: { id: memberId }, lock: { mode: 'pessimistic_write' } });
 const record = await em.getRepository(ExistingMemberRecord).findOneBy({ memberId });
 if (!member || !record) throw new NotFoundException('This dispatcher record no longer exists.');
 if (member.status === 'LEFT') throw new ConflictException('This person has left, so their paperwork is closed.');
 member.applicationId = applicationId;
 member.firstName = fields.preferredAmericanFirstName?.trim().slice(0, 100) || member.firstName;
 member.lastName = fields.preferredAmericanLastName?.trim().slice(0, 100) || member.lastName;
 member.version += 1;
 await em.save(member);
 record.acceptedAt = at; record.acceptedBy = actorId;
 await em.save(record);
 await em.getRepository(DispatchEvent).save({ memberId, teamId: null, event: 'PAPERWORK_ACCEPTED', actorId, metadata: {} });
}
