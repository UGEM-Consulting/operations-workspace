import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { memberPlace } from '../dispatch/create-member';
import { companyEmailSql } from '../dispatch/lead-sign-in';
import { DispatchEvent, DispatchMember } from '../dispatch/dispatch.entity';
import { ListEvent, listNameKey } from '../lists/lists.entity';
import { usDay } from '../safety/screening-rules';
import type { User } from '../users/user.entity';
import { AddSeatDto, ChangeSeatDto, CreateAccountDto, UpdateAccountDto } from './load-boards.dto';
import { LoadBoardAccount, LoadBoardSeat, PROVIDER_LABELS } from './load-boards.entity';
import { memberSeats, refreshRemovalSeats, signInUsers } from './seats';

const midday = (date: string) => new Date(`${date}T12:00:00Z`);
const DUPLICATES: Record<string, string> = {
 UQ_load_board_accounts_nameKey: 'A load board account with this name already exists.',
 UQ_member_load_board_seats_open: 'They already have a seat on this account. Change that one instead.',
};

/**
 * Load board accounts and seats (section 33, approved 2026-11-13). IT and administrators keep the list of the company's DAT
 * and Truckstop accounts and who has a seat on each; dispatch managers read them. Events hold actions and flags, never
 * sign-in emails. A seat change while IT is removing someone's access updates IT's checklist.
 */
@Injectable()
export class LoadBoardsService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService) {}
 private get fictionalOnly() { return !(this.config.get('NODE_ENV') === 'production' || this.config.get('DEPLOYMENT_PURPOSE') === 'production'); }

 /** The accounts with how many people (not left) hold an open seat on each. */
 async accounts(status: 'ACTIVE' | 'ARCHIVED' | 'ALL' = 'ALL') {
  const items = await this.db.query(`SELECT a.id, a.provider, a.name, a."mcId", m.name AS mc, m."archivedAt" IS NOT NULL AS "mcArchived", a."companyName", a.placeholder, a."archivedAt" IS NOT NULL AS archived, a.version,
    (SELECT count(*)::integer FROM member_load_board_seats s JOIN dispatch_members d ON d.id = s."memberId" WHERE s."accountId" = a.id AND s.status <> 'ENDED' AND d.status <> 'LEFT') AS people
   FROM load_board_accounts a LEFT JOIN mcs m ON m.id = a."mcId" WHERE ($1 = 'ALL' OR ($1 = 'ACTIVE') = (a."archivedAt" IS NULL)) ORDER BY a.placeholder, a."nameKey"`, [status]);
  const [counts] = await this.db.query(`SELECT count(*) FILTER (WHERE "archivedAt" IS NULL)::integer AS active, count(*) FILTER (WHERE "archivedAt" IS NOT NULL)::integer AS archived FROM load_board_accounts`);
  // The MCs an account can be under (archived ones too): IT reads no other list.
  const mcs = await this.db.query(`SELECT id, name, "archivedAt" IS NOT NULL AS archived FROM mcs ORDER BY "archivedAt" IS NOT NULL, "nameKey"`);
  return { items, counts, mcs };
 }

 /** One account's page: everyone holding a seat now (with their place and who shares their sign-in) and the history. */
 async account(id: string, user: User) {
  const [account] = await this.db.query(`SELECT a.*, m.name AS mc FROM load_board_accounts a LEFT JOIN mcs m ON m.id = a."mcId" WHERE a.id = $1`, [id]);
  if (!account) throw new NotFoundException('This load board account no longer exists.');
  const rows: { id: string; memberId: string; name: string; position: string; supportType: string; memberStatus: string; signInEmail: string; status: string; startedAt: Date; suspendedAt: Date | null; endedAt: Date | null; endedHow: string | null; version: number }[] = await this.db.query(`SELECT s.id, s."memberId",
    d."firstName" || ' ' || d."lastName" AS name, d.position, d."supportType", d.status AS "memberStatus", s."signInEmail", s.status, s."startedAt", s."suspendedAt", s."endedAt", s."endedHow", s.version
   FROM member_load_board_seats s JOIN dispatch_members d ON d.id = s."memberId" WHERE s."accountId" = $1 ORDER BY (s.status = 'ENDED'), lower(d."firstName"), lower(d."lastName"), s."startedAt" DESC`, [id]);
  const users = await signInUsers(this.db.manager, [...new Set(rows.filter(row => row.status !== 'ENDED').map(row => row.signInEmail))]);
  // Sign-ins show to IT and administrators here; managers see them on each person's page.
  const seesSignIns = user.role !== 'DISPATCHER_MANAGER';
  const seats = await Promise.all(rows.map(async row => ({ ...row, signInEmail: seesSignIns ? row.signInEmail : null, ...(row.status === 'ENDED' ? { mcName: null, teamName: null } : await memberPlace(this.db.manager, row.memberId)),
   sharedWith: row.status === 'ENDED' ? [] : users.filter(other => other.email === row.signInEmail && other.memberId !== row.memberId).map(other => other.name) })));
  return { account: { id: account.id, provider: account.provider, name: account.name, mcId: account.mcId, mc: account.mc, companyName: account.companyName, placeholder: account.placeholder, archived: !!account.archivedAt, version: account.version },
   using: seats.filter(seat => seat.status !== 'ENDED'), history: seats.filter(seat => seat.status === 'ENDED') };
 }

 async createAccount(user: User, dto: CreateAccountDto) {
  return this.write(async em => {
   await this.checkMc(em, dto.mcId);
   const account = await em.getRepository(LoadBoardAccount).save({ provider: dto.provider, name: dto.name, nameKey: listNameKey(dto.name), mcId: dto.mcId ?? null, companyName: dto.companyName || null });
   await this.listEvent(em, account.id, user, 'CREATED', { fields: ['provider', 'name', ...(dto.mcId ? ['mcId'] : []), ...(dto.companyName ? ['companyName'] : [])] });
   return { id: account.id, version: account.version };
  });
 }

 async updateAccount(user: User, id: string, dto: UpdateAccountDto) {
  return this.write(async em => {
   const account = await em.getRepository(LoadBoardAccount).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!account) throw new NotFoundException('This load board account no longer exists.');
   if (account.version !== dto.version) throw new ConflictException('Someone else changed this account. Reload and try again.');
   if (account.placeholder) throw new BadRequestException('This entry holds sign-ins recorded before the list. Move each seat to its real account instead.');
   const fields: string[] = [];
   if (dto.name !== undefined && dto.name !== account.name) { account.name = dto.name; account.nameKey = listNameKey(dto.name); fields.push('name'); }
   if (dto.mcId !== undefined && (dto.mcId ?? null) !== account.mcId) { await this.checkMc(em, dto.mcId ?? undefined); account.mcId = dto.mcId ?? null; fields.push('mcId'); }
   if (dto.companyName !== undefined && (dto.companyName || null) !== account.companyName) { account.companyName = dto.companyName || null; fields.push('companyName'); }
   const archive = dto.archived === undefined || dto.archived === !!account.archivedAt ? null : dto.archived;
   if (archive) {
    const [{ open }] = await em.query(`SELECT count(*)::integer AS open FROM member_load_board_seats WHERE "accountId" = $1 AND status <> 'ENDED'`, [id]);
    if (open) throw new ConflictException(`${open} ${open === 1 ? 'person has' : 'people have'} a seat on this account. Move or end their seats first.`);
   }
   if (archive !== null) account.archivedAt = archive ? new Date() : null;
   if (!fields.length && archive === null) return { id, version: account.version };
   account.version += 1; await em.save(account);
   if (fields.length) await this.listEvent(em, id, user, 'UPDATED', { fields });
   if (archive !== null) await this.listEvent(em, id, user, archive ? 'ARCHIVED' : 'RESTORED', {});
   return { id, version: account.version };
  });
 }

 /** A new seat on an account from the list. Sharing a sign-in is allowed and shown. */
 async addSeat(user: User, dto: AddSeatDto) {
  this.checkEmail(dto.signInEmail);
  this.checkDay(dto.startedOn);
  return this.write(async em => {
   const member = await em.getRepository(DispatchMember).findOne({ where: { id: dto.memberId }, lock: { mode: 'pessimistic_write' } });
   if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
   if (member.status === 'LEFT') throw new ConflictException('They have left. Their seats are kept as history.');
   const account = await this.usableAccount(em, dto.accountId);
   const seat = await em.getRepository(LoadBoardSeat).save({ memberId: member.id, accountId: account.id, signInEmail: dto.signInEmail, startedAt: midday(dto.startedOn), createdBy: user.id });
   await this.seatEvent(em, user, member.id, 'SEAT_ADDED', { provider: account.provider, shared: await this.shared(em, member.id, dto.signInEmail) });
   await refreshRemovalSeats(em, member.id, user.id);
   return { id: seat.id, version: seat.version };
  });
 }

 async changeSeat(user: User, id: string, dto: ChangeSeatDto) {
  if (dto.signInEmail) this.checkEmail(dto.signInEmail);
  if (dto.on) this.checkDay(dto.on);
  return this.write(async em => {
   const found = await em.getRepository(LoadBoardSeat).findOneBy({ id });
   if (!found) throw new NotFoundException('This seat no longer exists.');
   // The member first, then the seat: the order adding a seat takes them in.
   const member = await em.getRepository(DispatchMember).findOne({ where: { id: found.memberId }, lock: { mode: 'pessimistic_write' } });
   const seat = await em.getRepository(LoadBoardSeat).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!member || !seat) throw new NotFoundException('This seat no longer exists.');
   if (seat.version !== dto.version) throw new ConflictException('Someone else changed this seat. Reload and try again.');
   if (seat.status === 'ENDED') throw new ConflictException('This seat has ended. It’s kept as history.');
   const account = await em.getRepository(LoadBoardAccount).findOneByOrFail({ id: seat.accountId });
   const on = dto.on ? midday(dto.on) : new Date();
   if (dto.on && on < seat.startedAt && dto.action !== 'EMAIL') throw new BadRequestException('That day is before the seat began.');
   const metadata: Record<string, unknown> = { action: dto.action, provider: account.provider };
   let next: string | null = null;
   if (dto.action === 'SUSPEND') {
    if (seat.status !== 'ACTIVE') throw new ConflictException('This seat is already suspended.');
    Object.assign(seat, { status: 'SUSPENDED', suspendedAt: on });
   } else if (dto.action === 'RESUME') {
    if (seat.status !== 'SUSPENDED') throw new ConflictException('This seat isn’t suspended.');
    Object.assign(seat, { status: 'ACTIVE', suspendedAt: null });
   } else if (dto.action === 'EMAIL') {
    if (dto.signInEmail === seat.signInEmail) return { id, version: seat.version };
    seat.signInEmail = dto.signInEmail!;
    metadata.shared = await this.shared(em, member.id, seat.signInEmail);
   } else {
    if (member.status === 'LEFT') throw new ConflictException('They have left. IT ends their seats with their removal.');
    Object.assign(seat, { status: 'ENDED', suspendedAt: null, endedAt: on, endedHow: dto.action === 'MOVE' ? 'MOVED' : 'ENDED', endedBy: user.id });
   }
   seat.version += 1; await em.save(seat);
   if (dto.action === 'MOVE') {
    const target = await this.usableAccount(em, dto.accountId!);
    if (target.id === account.id) throw new BadRequestException('Choose another account to move the seat to.');
    const email = dto.signInEmail ?? seat.signInEmail;
    next = (await em.getRepository(LoadBoardSeat).save({ memberId: member.id, accountId: target.id, signInEmail: email, startedAt: on, createdBy: user.id })).id;
    Object.assign(metadata, { to: target.provider, shared: await this.shared(em, member.id, email) });
   }
   await this.seatEvent(em, user, member.id, 'SEAT_CHANGED', metadata);
   await refreshRemovalSeats(em, member.id, user.id);
   return { id, version: seat.version, ...(next ? { movedTo: next } : {}) };
  });
 }

 /**
  * Who can get a seat, for IT's Add seat on an account page: everyone who hasn't left, with their company email (offered as
  * the sign-in first). IT reads no dispatcher pages, so this is all it gets: names and work details.
  */
 people() {
  return this.db.query(`SELECT d.id, d."firstName" || ' ' || d."lastName" AS name, d.position, d."supportType", ${companyEmailSql('d', 'e')} AS "companyEmail"
   FROM dispatch_members d LEFT JOIN existing_member_records e ON e."memberId" = d.id WHERE d.status <> 'LEFT' ORDER BY lower(d."firstName"), lower(d."lastName"), d.id`);
 }
 /** Someone's seats for their page, open ones first with who shares each sign-in. */
 seats(memberId: string) { return memberSeats(this.db.manager, memberId, true); }

 private async usableAccount(em: EntityManager, id: string) {
  const account = await em.getRepository(LoadBoardAccount).findOneBy({ id });
  if (!account) throw new NotFoundException('This load board account no longer exists.');
  if (account.placeholder) throw new BadRequestException(`Choose the ${PROVIDER_LABELS[account.provider]} account they use. “Account not recorded” only holds sign-ins from before the list.`);
  if (account.archivedAt) throw new BadRequestException('This account is archived. Restore it first, or choose another.');
  return account;
 }
 private async checkMc(em: EntityManager, mcId: string | undefined) {
  if (mcId && !(await em.query(`SELECT 1 FROM mcs WHERE id = $1`, [mcId])).length) throw new BadRequestException('Choose an MC from the list.');
 }
 private checkEmail(email: string) {
  if (this.fictionalOnly && !email.endsWith('@example.test')) throw new BadRequestException('Outside production, a sign-in must be a fictional example.test address.');
 }
 private checkDay(day: string) {
  if (day > usDay('latest')) throw new BadRequestException('That day is in the future.');
  if (day < '1980-01-01') throw new BadRequestException('That day is too long ago.');
 }
 private async shared(em: EntityManager, memberId: string, email: string) {
  return (await signInUsers(em, [email])).some(other => other.memberId !== memberId);
 }
 private seatEvent(em: EntityManager, user: User, memberId: string, event: 'SEAT_ADDED' | 'SEAT_CHANGED', metadata: Record<string, unknown>) {
  return em.getRepository(DispatchEvent).save({ memberId, teamId: null, event, actorId: user.id, metadata });
 }
 private listEvent(em: EntityManager, itemId: string, user: User, event: 'CREATED' | 'UPDATED' | 'ARCHIVED' | 'RESTORED', metadata: Record<string, unknown>) {
  return em.getRepository(ListEvent).save({ list: 'LOAD_BOARD_ACCOUNT', itemId, actorId: user.id, event, metadata });
 }
 private async write<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
  try { return await this.db.transaction(work); }
  catch (error) {
   const driver = error instanceof QueryFailedError ? error.driverError as { code?: string; constraint?: string } : null;
   if (driver?.code === '23505') throw new ConflictException(DUPLICATES[driver.constraint ?? ''] ?? 'This already exists.');
   throw error;
  }
 }
}
