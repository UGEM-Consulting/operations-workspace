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
import { createRemoval } from '../it/removal';
import { NotificationsService } from '../updates/notifications.service';
import { lockCatchUpLinks, lockTeam, paperworkTimeEnded, supportedDispatcher } from './create-member';
import { DispatchEvent, DispatchMember, ExistingMemberRecord, MemberAssignment, MemberNotice, MemberPaperDocument, MemberSupportLink, NO_MC, Position, SupportType, Team } from './dispatch.entity';
import { ExistingRowDto, UpdateExistingDto } from './dispatch.dto';

const IMPORT_LOCK = 42002037, LINK_DAYS = 14, NOT_LISTED_TEAM = 'No team yet', INDEPENDENT = 'Independent';
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
/** Stored at midday UTC, as dates picked in forms are, so it shows as the same day in every US time zone. */
const midday = (date: string) => new Date(`${date}T12:00:00Z`);

export type RowStatus = 'READY' | 'CHOICE' | 'PROBLEM' | 'ALREADY';
export interface RowResult { row: number; name: string; position: 'DISPATCHER' | 'SUPPORT'; supportType: SupportType; status: RowStatus; problems: string[]; sameName: boolean;
 mcId: string | null; teamId: string | null; jobTitleId: string | null; supportsMemberId: string | null; supportsRow: number | null; startedOn: string | null; noMc: boolean; mcFromTeam: boolean }
export interface Choice { field: 'mc' | 'team' | 'jobTitle'; text: string; mc?: string; rows: number[] }

interface Known {
 mcs: Map<string, { id: string; name: string }>; teams: { id: string; name: string; mcId: string; lead: string | null }[]; titles: Map<string, string>;
 members: { id: string; name: string; position: string; mc: string | null; placed: boolean; leaving: boolean }[];
 companyEmails: Set<string>; personalEmails: Set<string>; phones: Set<string>;
}
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
  const dispatchers = await this.db.query(`SELECT d.id, d."firstName" || ' ' || d."lastName" AS name, CASE WHEN a.id IS NULL THEN '${NO_MC}' ELSE m.name END AS mc FROM dispatch_members d
   LEFT JOIN member_assignments a ON a."memberId" = d.id AND a."endedAt" IS NULL LEFT JOIN mcs m ON m.id = a."mcId"
   WHERE d.position = 'DISPATCHER' AND d.status <> 'LEFT' AND NOT EXISTS (SELECT 1 FROM member_notices n WHERE n."memberId" = d.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL)
   ORDER BY lower(d."firstName"), lower(d."lastName")`);
  return { mcs, teams, jobTitles, dispatchers };
 }
 private async known(em: EntityManager): Promise<Known> {
  const mcs: { id: string; name: string }[] = await em.query(`SELECT id, name FROM mcs WHERE "archivedAt" IS NULL`);
  const teams = await em.query(`SELECT t.id, t.name, t."mcId", CASE WHEN l.id IS NULL THEN NULL ELSE l."firstName" || ' ' || l."lastName" END AS lead
   FROM teams t LEFT JOIN dispatch_members l ON l.id = t."leadMemberId" WHERE t."archivedAt" IS NULL`);
  const titles: { id: string; name: string }[] = await em.query(`SELECT id, name FROM job_titles WHERE "archivedAt" IS NULL`);
  const members: Known['members'] = await em.query(`SELECT d.id, d."firstName" || ' ' || d."lastName" AS name, d.position, m.name AS mc, a.id IS NOT NULL AS placed,
    EXISTS (SELECT 1 FROM member_notices n WHERE n."memberId" = d.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL) AS leaving
   FROM dispatch_members d LEFT JOIN member_assignments a ON a."memberId" = d.id AND a."endedAt" IS NULL LEFT JOIN mcs m ON m.id = a."mcId" WHERE d.status <> 'LEFT'`);
  // Everyone current: added by hand, set up by IT, or an applicant's verified email and phone.
  const rows: { company: string | null; personal: string | null; phone: string | null }[] = await em.query(`
   SELECT r."companyEmail" AS company, r."personalEmail" AS personal, r."personalPhone" AS phone FROM existing_member_records r JOIN dispatch_members d ON d.id = r."memberId" WHERE d.status <> 'LEFT'
   UNION ALL SELECT r."companyEmail", i.email, s.fields->>'personalPhoneNumber' FROM dispatch_members d JOIN dispatcher_applications a ON a.id = d."applicationId" JOIN invitations i ON i.id = a."invitationId"
    LEFT JOIN it_onboarding_requests r ON r."applicationId" = a.id LEFT JOIN LATERAL (SELECT fields FROM application_submissions x WHERE x."applicationId" = a.id ORDER BY x.version DESC LIMIT 1) s ON true WHERE d.status <> 'LEFT'
   UNION ALL SELECT CASE WHEN c.kind = 'EMAIL' THEN c.value END, CASE WHEN c.kind = 'EMAIL' THEN c.value END, CASE WHEN c.kind = 'PHONE' THEN c.value END FROM member_contacts c JOIN dispatch_members d ON d.id = c."memberId" WHERE c."removedAt" IS NULL AND d.status <> 'LEFT'`);
  const values = (pick: (row: typeof rows[number]) => string | null) => new Set(rows.map(pick).filter((value): value is string => !!value));
  return { mcs: new Map(mcs.map(item => [listNameKey(item.name), item])), teams, titles: new Map(titles.map(item => [listNameKey(item.name), item.id])), members,
   companyEmails: new Set([...values(row => row.company)].map(value => value.toLowerCase())), personalEmails: new Set([...values(row => row.personal)].map(value => value.toLowerCase())), phones: new Set([...values(row => row.phone)].map(digits)) };
 }
 /** Checks every row against the lists and the people already here. Pure: nothing is written. */
 private evaluate(rows: ExistingRowDto[], known: Known) {
  const today = usDay('latest'), choices = new Map<string, Choice>();
  const choice = (entry: Omit<Choice, 'rows'>, row: number) => {
   const key = `${entry.field}|${listNameKey(entry.mc ?? '')}|${listNameKey(entry.text)}`;
   const found = choices.get(key) ?? { ...entry, rows: [] };
   found.rows.push(row); choices.set(key, found);
  };
  const seenCompany = new Map<string, number>(), seenPersonal = new Map<string, number>(), seenPhone = new Map<string, number>(), seenName = new Map<string, number>(), seenAnyName = new Map<string, number>(), seenNoMc = new Map<string, number>();
  const results: RowResult[] = rows.map(row => {
   const first = text(row.firstName), last = text(row.lastName), problems: string[] = [], { position, supportType, known: positionKnown } = readPosition(text(row.position));
   const name = `${first} ${last}`.trim();
   let status: RowStatus = 'READY', mcId: string | null = null, teamId: string | null = null, jobTitleId: string | null = null, already = '', sameName = false, noMc = false, mcFromTeam = false;
   if (!first || !last) problems.push('First and last name are both needed.');
   if (first.length > 100 || last.length > 100) problems.push('Names can be up to 100 characters.');
   if (!positionKnown) problems.push(`Position “${text(row.position)}” should be Dispatcher, Support or Updater.`);
   const started = text(row.startedOn), startedOn = started ? fileDate(started) : null;
   // An empty start date is fine: it can be added on their page later. A date that can't be read is a mistake to fix.
   if (started && !startedOn) problems.push(`Started on “${started}” isn’t a date.`);
   else if (startedOn && startedOn > today) problems.push('Started on can’t be in the future.');
   else if (startedOn && startedOn < '1980-01-01') problems.push(`Started on “${started}” is too long ago.`);
   for (const [label, value] of [['NDA', text(row.ndaSignedOn)], ['SOP', text(row.sopSignedOn)]] as const) {
    if (!value) continue;
    const date = fileDate(value);
    if (!date) problems.push(`${label} signed on “${value}” isn’t a date.`);
    else if (date > today) problems.push(`${label} signed on can’t be in the future.`);
   }
   const company = text(row.companyEmail).toLowerCase(), personal = text(row.personalEmail).toLowerCase(), number = text(row.ringCentralNumber), phone = text(row.personalPhone);
   for (const [label, value] of [['Company email', company], ['Personal email', personal]] as const) {
    if (!value) continue;
    if (!EMAIL.test(value) || value.length > 254) problems.push(`${label} “${value}” doesn’t look right.`);
    else if (this.fictionalOnly && !value.endsWith('@example.test')) problems.push(`Outside production, ${label.toLowerCase()} must be a fictional example.test address.`);
   }
   for (const [label, value] of [['RingCentral number', number], ['Personal phone', phone]] as const) if (value && (value.length > 40 || !INTERNATIONAL_PHONE_PATTERN.test(value))) problems.push(`${label} “${value}” should have 7 to 15 digits.`);
   if (company && known.companyEmails.has(company)) already = 'Already in the workspace with this company email. This row is left out.';
   else if (personal && known.personalEmails.has(personal)) already = 'Already in the workspace with this personal email. This row is left out.';
   else if (phone && known.phones.has(digits(phone))) already = 'Already in the workspace with this personal phone. This row is left out.';
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
   if (position === 'DISPATCHER') {
    const mcText = text(row.mc), teamText = text(row.team), titleText = text(row.jobTitle), independent = listNameKey(mcText) === listNameKey(INDEPENDENT);
    const named = listNameKey(mcText) !== listNameKey(NO_MC) && !!mcText, wantsTeam = !!teamText && listNameKey(teamText) !== listNameKey(NOT_LISTED_TEAM);
    const mc = named ? known.mcs.get(listNameKey(mcText)) : undefined;
    let teamMc: string | null = null;
    if (named && !independent && !mc) choice({ field: 'mc', text: mcText }, row.row);
    mcId = mc?.id ?? null;
    if (!named) {
     // Every team belongs to one MC, so a team with no MC brings its MC. "No MC yet" says to leave them out of any team for now.
     const teams = !mcText && wantsTeam ? matchingTeams(known.teams, teamText) : [];
     const owner = teams.length === 1 ? [...known.mcs.values()].find(item => item.id === teams[0].mcId) : undefined;
     if (owner) { mcId = owner.id; teamId = teams[0].id; teamMc = owner.name; mcFromTeam = true; }
     else if (!mcText && wantsTeam) choice({ field: 'team', text: teamText }, row.row);
     else noMc = true;
    }
    if (mc && wantsTeam) {
     const team = matchingTeams(known.teams.filter(item => item.mcId === mc.id), teamText)[0];
     if (team) teamId = team.id; else choice({ field: 'team', text: teamText, mc: mc.name }, row.row);
    }
    if (independent && teamText && ![INDEPENDENT, NOT_LISTED_TEAM].map(listNameKey).includes(listNameKey(teamText))) problems.push('An Independent dispatcher has no team.');
    jobTitleId = known.titles.get(listNameKey(titleText)) ?? null;
    // A position it can't read says so once: it may not be a dispatcher at all, so nothing is asked about a job title until it's corrected.
    if (positionKnown && !titleText) problems.push('Job title is empty.');
    else if (positionKnown && !jobTitleId) choice({ field: 'jobTitle', text: titleText }, row.row);
    // A blank MC with a team we can't find is still to be chosen, so it can't match anyone's MC yet: least of all Independent's, which is also blank.
    const mcPending = !named && !noMc && !mcFromTeam, mcName = independent ? null : mc?.name ?? teamMc ?? mcText, nameKey = listNameKey(name);
    // Someone with no MC yet could be anyone of that name, so setting their MC with a second upload can't add them twice.
    const sameNames = known.members.filter(item => item.position === 'DISPATCHER' && listNameKey(item.name) === nameKey);
    if (!already && !row.differentPerson && sameNames.some(item => !item.placed || noMc)) {
     already = 'Same name as someone in the workspace, and one of them has no MC yet. Left out unless you say they’re different people. To set an MC, use their page.'; sameName = true;
    } else if (!already && !row.differentPerson && !mcPending && sameNames.some(item => listNameKey(item.mc ?? '') === listNameKey(mcName ?? ''))) {
     already = 'Same name and MC as someone in the workspace. Left out unless you say they’re different people.'; sameName = true;
    }
    if (name) {
     const earlier = noMc ? seenAnyName.get(nameKey) : seenNoMc.get(nameKey);
     if (earlier !== undefined && !already && !row.differentPerson) { problems.push(`Same name as row ${earlier}, and one of them has no MC yet. Left out unless you say they’re different people.`); sameName = true; }
     else if (!mcPending) sameInFile(`DISPATCHER|${nameKey}|${listNameKey(mcName ?? '')}`, 'name and MC');
     if (!seenAnyName.has(nameKey)) seenAnyName.set(nameKey, row.row);
     if (noMc && !seenNoMc.has(nameKey)) seenNoMc.set(nameKey, row.row);
    }
   } else {
    if (text(row.mc) || text(row.team) || text(row.jobTitle)) problems.push(`${capitalized(aSupport(supportType))} has no MC, team or job title of their own. Leave them empty.`);
    if (!already && !row.differentPerson && known.members.some(item => item.position === 'SUPPORT' && listNameKey(item.name) === listNameKey(name))) {
     already = 'Same name as a support or updater in the workspace. Left out unless you say they’re different people.'; sameName = true;
    }
    if (name) sameInFile(`SUPPORT|${listNameKey(name)}`, 'name');
   }
   if (already) { status = 'ALREADY'; problems.unshift(already); }
   return { row: row.row, name, position, supportType, status, problems, sameName, mcId, teamId, jobTitleId, supportsMemberId: null, supportsRow: null, startedOn, noMc, mcFromTeam };
  });
  for (const result of results) if (result.status === 'READY' && result.problems.length) result.status = 'PROBLEM';
  for (const entry of choices.values()) for (const number of entry.rows) { const result = results.find(item => item.row === number)!; if (result.status === 'READY') result.status = 'CHOICE'; }
  // Supports last: their dispatcher may be another row in the same file.
  rows.forEach((row, index) => {
   const result = results[index];
   if (result.position !== 'SUPPORT' || result.status === 'ALREADY') return;
   if (row.supportsMemberId) {
    const picked = known.members.find(item => item.id === row.supportsMemberId && item.position === 'DISPATCHER');
    if (!picked) { result.problems.push(`Choose a current dispatcher for ${aSupport(result.supportType)}.`); result.status = 'PROBLEM'; }
    else if (picked.leaving) { result.problems.push(`“${picked.name}” is leaving. Choose another dispatcher.`); result.status = 'PROBLEM'; }
    else result.supportsMemberId = picked.id;
    return;
   }
   const wanted = listNameKey(text(row.supports));
   if (!wanted) { result.problems.push(`${capitalized(aSupport(result.supportType))} needs the dispatcher they assist.`); result.status = 'PROBLEM'; return; }
   const here = known.members.filter(item => item.position === 'DISPATCHER' && listNameKey(item.name) === wanted);
   const inFile = results.filter(item => item.position === 'DISPATCHER' && listNameKey(item.name) === wanted && item.status !== 'ALREADY');
   if (here.length + inFile.length > 1) { result.problems.push(`More than one dispatcher is called “${text(row.supports)}”. Use Add one person for ${result.supportType === 'UPDATER' ? 'this updater' : 'this support'} and choose their dispatcher from the list.`); result.status = 'PROBLEM'; }
   else if (here[0]?.leaving) { result.problems.push(`“${text(row.supports)}” is leaving. Choose another dispatcher.`); result.status = 'PROBLEM'; }
   else if (here[0]) result.supportsMemberId = here[0].id;
   else if (inFile[0]?.status === 'READY') result.supportsRow = inFile[0].row;
   else if (inFile[0]) { result.problems.push(`“${text(row.supports)}” in row ${inFile[0].row} isn’t ready yet.`); if (result.status === 'READY') result.status = 'CHOICE'; }
   else { result.problems.push(`${result.supportType === 'UPDATER' ? 'Assists' : 'Supports'} “${text(row.supports)}”, who isn’t in this file or the workspace.`); result.status = 'PROBLEM'; }
  });
  return { results, choices: [...choices.values()] };
 }
 async check(rows: ExistingRowDto[]) {
  const { results, choices } = this.evaluate(rows, await this.known(this.db.manager));
  return { rows: results.map(({ row, name, position, supportType, status, problems, sameName }) => ({ row, name, position, supportType, status, problems, sameName })), choices, counts: this.counts(results) };
 }
 private counts(results: RowResult[]) {
  const count = (status: RowStatus) => results.filter(row => row.status === status).length;
  const ready = results.filter(row => row.status === 'READY');
  return { ready: count('READY'), choice: count('CHOICE'), problem: count('PROBLEM'), already: count('ALREADY'), noStartDate: ready.filter(row => !row.startedOn).length, noMc: ready.filter(row => row.noMc).length, mcFromTeam: ready.filter(row => row.mcFromTeam).length };
 }
 /** Adds the rows that are ready, checked again under one lock so two uploads can't both add the same person. */
 async add(user: User, rows: ExistingRowDto[], sourceName?: string) {
  await onboardingLimit(this.db, 'existing-add:' + user.id, 60, 3600);
  return this.db.transaction(async em => {
   await em.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK]);
   const known = await this.known(em), { results } = this.evaluate(rows, known);
   const ready = results.filter(row => row.status === 'READY'), byRow = new Map(rows.map(row => [row.row, row])), added = new Map<number, string>();
   const locked = new Map<string, Team>();
   // Read FOR SHARE and checked again, members before teams: leaving doesn't take the import lock, and refuses while supports are linked.
   for (const id of [...new Set(ready.flatMap(row => row.supportsMemberId ?? []))].sort()) await supportedDispatcher(em, id);
   // Dispatchers first: a support in the same file links to them.
   for (const result of [...ready.filter(row => row.position === 'DISPATCHER'), ...ready.filter(row => row.position === 'SUPPORT')]) {
    // With no start date, joinedAt and any first period keep the day they were added, marked as not recorded so it never shows as real.
    const row = byRow.get(result.row)!, startedAt = midday(result.startedOn ?? usDay('latest')), hasPeriod = !result.noMc;
    if (result.teamId && !locked.has(result.teamId)) {
     const team = await lockTeam(em, result.teamId);
     if (!team || team.archivedAt || team.mcId !== result.mcId) throw new ConflictException('A team changed while this was being added. Check the rows again.');
     locked.set(result.teamId, team);
    }
    const [first, ...rest] = result.name.split(' ');
    const member = await em.getRepository(DispatchMember).save({ applicationId: null, firstName: text(row.firstName) || first, lastName: text(row.lastName) || rest.join(' '), position: result.position, supportType: result.supportType, status: 'ACTIVE', jobTitleId: result.jobTitleId, joinedAt: startedAt });
    if (result.position === 'DISPATCHER') { if (hasPeriod) await em.getRepository(MemberAssignment).save({ memberId: member.id, mcId: result.mcId, teamId: result.teamId, startedAt, reason: 'Added as an existing dispatcher.', actorId: user.id }); }
    else {
     const dispatcherId = result.supportsMemberId ?? added.get(result.supportsRow!);
     if (!dispatcherId) throw new ConflictException('A dispatcher changed while this was being added. Check the rows again.');
     await em.getRepository(MemberSupportLink).save({ supportId: member.id, dispatcherId, startedAt, reason: result.supportType === 'UPDATER' ? 'Added as an existing updater.' : 'Added as an existing support.', actorId: user.id });
    }
    await em.getRepository(ExistingMemberRecord).save({ memberId: member.id, addedBy: user.id, sourceName: sourceName?.trim().slice(0, 200) || null,
     companyEmail: text(row.companyEmail).toLowerCase() || null, ringCentralNumber: text(row.ringCentralNumber) || null, personalEmail: text(row.personalEmail).toLowerCase() || null, personalPhone: text(row.personalPhone) || null, startDateKnown: !!result.startedOn, periodDateKnown: !!result.startedOn || !hasPeriod });
    let paper = 0;
    for (const [kind, value] of [['NDA', text(row.ndaSignedOn)], ['SOP', text(row.sopSignedOn)]] as const) {
     if (!value) continue;
     await em.getRepository(MemberPaperDocument).save({ memberId: member.id, kind, signedOn: fileDate(value)!, recordedBy: user.id }); paper += 1;
    }
    await em.getRepository(DispatchEvent).save({ memberId: member.id, teamId: null, event: 'EXISTING_ADDED', actorId: user.id, metadata: { source: sourceName ? 'file' : 'form', paper, noStartDate: !result.startedOn, noMc: result.noMc } });
    added.set(result.row, member.id);
   }
   return { added: added.size, members: [...added.entries()].map(([row, id]) => ({ row, id })),
    left: results.filter(row => row.status !== 'READY').map(({ row, name, status, problems, sameName }) => ({ row, name, status, problems, sameName })) };
  });
 }
 /** Everyone added by hand who hasn't left, with what is outstanding. */
 async paperwork(user: User) {
  const rows: { id: string; firstName: string; lastName: string; position: string; supportType: string; mc: string | null; team: string | null; dispatcher: string | null; personalEmail: string | null; acceptedAt: Date | null;
   paper: { kind: string; signedOn: string }[]; signed: string[]; invitationId: string | null; expiresAt: Date | null; openedAt: Date | null; consumedAt: Date | null; applicationId: string | null; applicationStatus: string | null; managerId: string | null; accessUntil: Date | null; returnEmail: string | null }[] = await this.db.query(`
   SELECT d.id, d."firstName", d."lastName", d.position, d."supportType", CASE WHEN x.id IS NULL THEN '${NO_MC}' ELSE m.name END AS mc, t.name AS team, CASE WHEN sd.id IS NULL THEN NULL ELSE sd."firstName" || ' ' || sd."lastName" END AS dispatcher, r."personalEmail", r."acceptedAt",
    coalesce((SELECT json_agg(json_build_object('kind', p.kind, 'signedOn', p."signedOn"::text)) FROM member_paper_documents p WHERE p."memberId" = d.id), '[]') AS paper,
    coalesce((SELECT json_agg(DISTINCT c.kind) FROM document_signatures s JOIN company_documents c ON c.id = s."documentId" WHERE s."applicationId" = a.id AND s."signerRole" = 'APPLICANT'), '[]') AS signed,
    i.id AS "invitationId", i."expiresAt", i."openedAt", i."consumedAt", a.id AS "applicationId", a.status AS "applicationStatus", a."assignedManagerId" AS "managerId", a."applicantAccessUntil" AS "accessUntil", i.email AS "returnEmail"
   FROM existing_member_records r JOIN dispatch_members d ON d.id = r."memberId"
   LEFT JOIN LATERAL (SELECT * FROM member_support_links l WHERE l."supportId" = d.id AND l."endedAt" IS NULL LIMIT 1) sl ON true LEFT JOIN dispatch_members sd ON sd.id = sl."dispatcherId"
   LEFT JOIN LATERAL (SELECT * FROM member_assignments x WHERE x."memberId" = coalesce(sl."dispatcherId", d.id) AND x."endedAt" IS NULL LIMIT 1) x ON true LEFT JOIN mcs m ON m.id = x."mcId" LEFT JOIN teams t ON t.id = x."teamId"
   LEFT JOIN LATERAL (SELECT * FROM invitations v WHERE v."catchUpMemberId" = d.id AND v."revokedAt" IS NULL ORDER BY v."createdAt" DESC LIMIT 1) i ON true LEFT JOIN dispatcher_applications a ON a."invitationId" = i.id
   WHERE d.status <> 'LEFT' ORDER BY lower(d."firstName"), lower(d."lastName") LIMIT 1000`);
  const items = rows.map(row => {
   const canReview = !!row.managerId && (user.role === Role.SYSTEM_ADMIN || row.managerId === user.id);
   const expired = !row.consumedAt && !!row.expiresAt && row.expiresAt.getTime() < Date.now();
   const timeEnded = !!row.accessUntil && !!row.applicationStatus && paperworkTimeEnded({ consumedAt: row.consumedAt, status: row.applicationStatus, applicantAccessUntil: row.accessUntil });
   const state = row.acceptedAt ? 'FINISHED' : !row.invitationId || expired ? (row.personalEmail ? 'TO_CREATE' : 'NO_EMAIL') : !row.consumedAt ? (row.openedAt ? 'OPENED' : 'SENT') : timeEnded ? 'TIME_ENDED'
    : ['SUBMITTED', 'RESUBMITTED'].includes(row.applicationStatus ?? '') ? 'WAITING' : row.applicationStatus === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : 'IN_PROGRESS';
   return { id: row.id, firstName: row.firstName, lastName: row.lastName, position: row.position, supportType: row.supportType, mc: row.mc, team: row.team, dispatcher: row.dispatcher, personalEmail: row.personalEmail, state, linkExpired: expired,
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
     fields: { preferredAmericanFirstName: member.firstName, preferredAmericanLastName: member.lastName, ...(record.personalPhone ? { personalPhoneNumber: record.personalPhone } : {}) } });
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
   const others = await em.query(`SELECT "companyEmail" AS company, "personalEmail" AS personal, "personalPhone" AS phone FROM existing_member_records WHERE "memberId" = $1`, [id]);
   for (const own of others) { known.companyEmails.delete(own.company ?? ''); known.personalEmails.delete(own.personal ?? ''); known.phones.delete(digits(own.phone ?? '')); }
   const set = (field: 'companyEmail' | 'ringCentralNumber' | 'personalEmail' | 'personalPhone', value: string | undefined) => { if (value !== undefined && value !== (record[field] ?? '')) { record[field] = value || null; changed.push(field); } };
   for (const [field, used, label] of [['companyEmail', known.companyEmails, 'company email'], ['personalEmail', known.personalEmails, 'personal email']] as const) {
    const value = dto[field]?.toLowerCase();
    if (value && this.fictionalOnly && !value.endsWith('@example.test')) throw new BadRequestException(`Outside production, the ${label} must be a fictional example.test address.`);
    if (value && used.has(value)) throw new ConflictException(`Someone in the workspace already has this ${label}.`);
    set(field, value);
   }
   if (dto.personalPhone && known.phones.has(digits(dto.personalPhone))) throw new ConflictException('Someone in the workspace already has this personal phone.');
   set('ringCentralNumber', dto.ringCentralNumber); set('personalPhone', dto.personalPhone);
   const signed: { kind: string }[] = dto.ndaSignedOn === undefined && dto.sopSignedOn === undefined ? [] : await em.query(`SELECT DISTINCT c.kind FROM invitations i JOIN dispatcher_applications a ON a."invitationId" = i.id
     JOIN document_signatures s ON s."applicationId" = a.id AND s."signerRole" = 'APPLICANT' JOIN company_documents c ON c.id = s."documentId" WHERE i."catchUpMemberId" = $1`, [id]);
   for (const [kind, value] of [['NDA', dto.ndaSignedOn], ['SOP', dto.sopSignedOn]] as const) {
    if (value === undefined) continue;
    const existing = await em.getRepository(MemberPaperDocument).findOneBy({ memberId: id, kind });
    if (!value) { if (existing) { await em.remove(existing); changed.push(kind); } continue; }
    if (value > usDay('latest')) throw new BadRequestException(`The ${kind} date can’t be in the future.`);
    if (signed.some(row => row.kind === kind)) throw new ConflictException(`They already signed the ${kind} in the workspace.`);
    if (existing?.signedOn === value) continue;
    await em.getRepository(MemberPaperDocument).save({ ...(existing ?? { memberId: id, kind }), signedOn: value, recordedBy: user.id }); changed.push(kind);
   }
   if (!changed.length) return { id, version: member.version };
   member.version += 1; await em.save(member); await em.save(record);
   if (changed.includes('personalEmail')) await this.moveUnusedLink(em, user, id, record.personalEmail);
   const accounts = changed.filter(field => field === 'companyEmail' || field === 'ringCentralNumber');
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
  const { companyEmail, ringCentralNumber } = record;
  if (!removal) {
   const notice = await em.getRepository(MemberNotice).findOneBy({ memberId: member.id, cancelledAt: IsNull(), finishedAt: IsNull() });
   if (!notice || (!companyEmail && !ringCentralNumber)) return [];
   return createRemoval(em, this.alerts, { setup: null, accounts: { companyEmail, ringCentralNumber }, memberId: member.id, name: `${member.firstName} ${member.lastName}`, dueOn: notice.lastDay, scheduled: true, emailAfter: 'SUSPEND', actorId: user.id, mcName: null, teamName: null });
  }
  // Someone with IT setup: IT works from what it set up, not from this record.
  if (!removal.profile.noSetupRecord) return [];
  if (removal.completedAt) throw new ConflictException('IT has already finished removing their access. Tell IT about this account directly.');
  removal.profile = { ...removal.profile, companyEmail, ringCentralNumber };
  // Forwarding needs a mailbox, and what happens to a number is decided for that number.
  if (!companyEmail) { removal.emailAfter = 'SUSPEND'; removal.forwardTo = null; }
  if (fields.includes('ringCentralNumber')) removal.numberOutcome = null;
  removal.version += 1; await em.save(removal);
  const steps = [...(fields.includes('companyEmail') && companyEmail ? ['GOOGLE_WORKSPACE'] : []), ...(fields.includes('ringCentralNumber') && ringCentralNumber ? ['RINGCENTRAL'] : [])];
  let reopened = false;
  for (const task of steps.length ? await em.getRepository(ItRemovalTask).find({ where: { requestId: removal.id, key: In(steps), status: 'COMPLETED' } }) : []) {
   task.status = 'PENDING'; task.updatedBy = user.id; await em.save(task); reopened = true;
  }
  await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId: user.id, event: 'ACCOUNTS_CORRECTED', metadata: { reopened } });
  return [];
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
