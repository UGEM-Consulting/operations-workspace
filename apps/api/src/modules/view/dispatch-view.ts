import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DispatchService } from '../dispatch/dispatch.service';
import { MemberListService } from '../dispatch/member-list';
import { DriverAssignmentsService } from '../dispatch/driver-assignments.service';
import { PaperScansService } from '../dispatch/paper-scans';
import { DispatchEvent } from '../dispatch/dispatch.entity';
import { memberHistory } from '../dispatch/history';
import { DocumentsService } from '../documents/documents.service';
import { photoPresence } from '../documents/member-photos';
import { memberSeats } from '../load-boards/seats';
import { memberCompanyAccounts } from '../company-accounts/accounts';
import { onHoldSql } from '../safety/holds';
import type { User } from '../users/user.entity';
import { requireView } from '../users/view-access';
import { pick, pickAll } from './pick';
import type { ViewMembersQueryDto } from './view.dto';

/** What a row of Dispatchers shows a viewer: where they work, their status and work contacts. Never personal details. */
const ROW = ['id', 'firstName', 'lastName', 'position', 'supportType', 'status', 'joinedAt', 'leftAt', 'since', 'sinceKnown', 'startDateKnown', 'jobTitle', 'mc', 'team', 'wholeTeam', 'lead',
 'dispatcher', 'companyEmail', 'lastDay', 'drivers', 'ringCentralNumber', 'ringCentralExtension', 'telegram', 'otherName', 'helpers', 'loadBoards', 'matched'] as const;
const TABS = ['onboarding', 'active', 'onLeave', 'leaving', 'left', 'all'] as const;
// History for a viewer: what changed and who did it, never the reasons and notes staff wrote, who opened files, or IT's work.
const HIDDEN_HISTORY = ['VIEWS', 'IT'];

/**
 * Dispatch read only (section 39): its teams, dispatchers and drivers for someone given view-only access. Every answer is
 * built from an allowlist here, so a field added to Dispatch's own pages never reaches a viewer by itself. Photos and
 * signed documents need the grant's withFiles, and every one opened is recorded where Dispatch already lists who opened files.
 */
@Injectable()
export class DispatchViewService {
 constructor(private readonly db: DataSource, private readonly dispatch: DispatchService, private readonly list: MemberListService, private readonly assignments: DriverAssignmentsService,
  private readonly documents: DocumentsService, private readonly scans: PaperScansService) {}

 async teams(user: User) {
  await requireView(this.db, user, 'DISPATCH');
  const { items } = await this.dispatch.teams('ACTIVE');
  return { items: pickAll(items, ['id', 'name', 'mc', 'lead', 'members', 'onboarding', 'helpers']) };
 }

 async team(user: User, id: string) {
  const grant = await requireView(this.db, user, 'DISPATCH');
  const team = await this.dispatch.team(id);
  const person = ['id', 'firstName', 'lastName', 'status', 'position', 'supportType', 'photo', 'lastDay', 'onLeaveUntil'] as const;
  return { ...pick(team, ['id', 'name', 'archived', 'leadId']), mc: pick(team.mc as Record<string, unknown>, ['id', 'name']), withFiles: grant.withFiles,
   dispatchers: pickAll(team.dispatchers, [...person, 'jobTitle', 'drivers', 'companyEmail']), helpers: pickAll(team.helpers, [...person, 'dispatcherId', 'teamId']) };
 }

 async members(user: User, query: ViewMembersQueryDto) {
  await requireView(this.db, user, 'DISPATCH');
  const result = await this.list.list({ status: query.status ?? 'ACTIVE', search: query.search, page: query.page, pageSize: query.pageSize }, true);
  return { items: result.items.map(row), counts: pick(result.counts, TABS), total: result.total, page: result.page, pageSize: result.pageSize };
 }

 async member(user: User, id: string) {
  const grant = await requireView(this.db, user, 'DISPATCH');
  const found = await this.list.row(id);
  if (!found) throw new NotFoundException('This dispatcher record no longer exists.');
  const [[record], drivers, covered, seats, accounts, history, photos] = await Promise.all([
   this.db.query(`SELECT e."leftDateKnown" FROM existing_member_records e WHERE e."memberId" = $1`, [id]) as Promise<{ leftDateKnown: boolean }[]>,
   // Their drivers now, with the unit and, for a driver they cover for someone away, who and until when.
   this.db.query(`SELECT d.id, d."firstName" || ' ' || d."lastName" AS name, a."startedAt", coalesce(u.unit, a.truck) AS unit, u.kind AS "unitKind", ${onHoldSql('d')} AS "onHold",
     (SELECT json_build_object('for', o."firstName" || ' ' || o."lastName", 'until', l."backOn"::text) FROM driver_leave_covers c JOIN member_leaves l ON l.id = c."leaveId" JOIN dispatch_members o ON o.id = l."memberId"
      WHERE c."coverAssignmentId" = a.id AND c."endedAt" IS NULL) AS covering
    FROM driver_assignments a JOIN drivers d ON d.id = a."driverId" LEFT JOIN driver_trucks u ON u.id = a."unitId"
    WHERE a."memberId" = $1 AND a."endedAt" IS NULL ORDER BY lower(d."firstName"), lower(d."lastName")`, [id]),
   // While they're away: their drivers someone else covers.
   this.db.query(`SELECT d.id, d."firstName" || ' ' || d."lastName" AS name, cm."firstName" || ' ' || cm."lastName" AS cover, l."backOn"::text AS until
    FROM driver_leave_covers c JOIN member_leaves l ON l.id = c."leaveId" AND l."endedAt" IS NULL JOIN drivers d ON d.id = c."driverId" JOIN dispatch_members cm ON cm.id = c."coverMemberId"
    WHERE l."memberId" = $1 AND c."endedAt" IS NULL AND c."startedAt" IS NOT NULL ORDER BY lower(d."firstName")`, [id]),
   memberSeats(this.db.manager, id), memberCompanyAccounts(this.db.manager, id), memberHistory(this.db, id), photoPresence(this.db.manager, id)]);
  const entries = history.entries.filter(entry => !HIDDEN_HISTORY.includes(entry.category)).map(entry => ({ ...entry, body: null }));
  const counts = { ALL: entries.length, WORK: 0, ACCOUNTS: 0, AWAY: 0, DETAILS: 0 } as Record<string, number>;
  for (const entry of entries) counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  const leave = found.leave as { firstDay: string; backOn: string; started: boolean } | null;
  return { ...row(found), leftDateKnown: record?.leftDateKnown ?? true, leave: leave ? pick(leave, ['firstDay', 'backOn', 'started']) : null, drivers, covered,
   // Which accounts they use, never a sign-in, email or number.
   seats: seats.map(seat => ({ id: seat.id, account: seat.placeholder ? null : seat.account, provider: seat.provider, status: seat.status, shared: seat.sharedWith.length > 0 })),
   companyAccounts: accounts.map(account => ({ id: account.id, company: account.mc ?? account.companyName, status: account.status, email: !!account.companyEmail, number: !!account.ringCentralNumber, keptFor: account.keptFor })),
   timeline: { entries, counts }, photo: photos.profile, withFiles: grant.withFiles, files: grant.withFiles ? await this.files(id, photos.id) : null };
 }

 /** Photos and documents, for a viewer given them: what exists, never the files themselves. */
 private async files(id: string, idPhoto: boolean) {
  const [signed, paper, scans] = await Promise.all([
   this.db.query(`SELECT DISTINCT ON (c.id) c.id, c.kind, c.title, c.version, s."signedAt" FROM dispatch_members d JOIN dispatcher_applications a ON a.id = d."applicationId" AND a.status = 'APPROVED'
     JOIN document_signatures s ON s."applicationId" = a.id AND s."signerRole" = 'APPLICANT' JOIN company_documents c ON c.id = s."documentId" WHERE d.id = $1 ORDER BY c.id, s."signedAt"`, [id]),
   this.db.query(`SELECT kind, "signedOn"::text AS "signedOn" FROM member_paper_documents WHERE "memberId" = $1 ORDER BY kind`, [id]),
   this.db.query(`SELECT id, kind, "pageCount", "createdAt" FROM member_paper_scans WHERE "memberId" = $1 AND "replacedAt" IS NULL ORDER BY kind`, [id])]);
  return { idPhoto, signed, paper, scans };
 }

 /** Dispatch › Drivers as Dispatch reads it: cleared drivers, where they work and whether they're on hold (never why). */
 async drivers(user: User) {
  await requireView(this.db, user, 'DISPATCH');
  const { items } = await this.assignments.drivers(null);
  return { items: (items as Record<string, unknown>[]).map(item => ({ ...pick(item, ['id', 'firstName', 'lastName', 'phone', 'driverType', 'licenseType', 'clearedAt', 'onHold', 'gettingReady']),
   assignment: item.assignment ? pick(item.assignment as Record<string, unknown>, ['mc', 'dispatcher', 'team', 'truck', 'trailer', 'startedAt', 'covering']) : null })) };
 }

 async signedCopy(user: User, memberId: string, documentId: string) {
  await requireView(this.db, user, 'DISPATCH', true);
  // The applicant's version of the copy: without the company countersigner's IP and browser.
  const file = await this.documents.memberSignedCopy(user, memberId, documentId, 'applicant');
  const [doc] = await this.db.query(`SELECT kind FROM company_documents WHERE id = $1`, [documentId]) as { kind: string }[];
  await this.db.getRepository(DispatchEvent).save({ memberId, teamId: null, event: 'SIGNED_COPY_VIEWED', actorId: user.id, metadata: { kind: doc?.kind ?? null, role: user.role } });
  return file;
 }

 async paperScan(user: User, memberId: string, scanId: string) {
  await requireView(this.db, user, 'DISPATCH', true);
  // Recorded with the role, as signed copies are, so History marks it as opened view only.
  return this.scans.file(user, memberId, scanId, true);
 }
}

function row(item: Record<string, unknown>) {
 const leave = item.leave as { firstDay: string; backOn: string; started: boolean } | null;
 const shared = (item.shared as { kind: string; value: string; owner: string | null }[] | null) ?? [];
 return { ...pick(item, ROW), leave: leave ? pick(leave, ['firstDay', 'backOn', 'started']) : null, shared: shared.map(entry => pick(entry, ['kind', 'value', 'owner'])) };
}
