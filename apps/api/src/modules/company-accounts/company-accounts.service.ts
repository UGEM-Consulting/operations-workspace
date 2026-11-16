import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { DispatchEvent, DispatchMember } from '../dispatch/dispatch.entity';
import { usDay } from '../safety/screening-rules';
import type { User } from '../users/user.entity';
import { checkEmailFree, memberCompanyAccounts, refreshRemovalAccounts } from './accounts';
import { AddCompanyAccountDto, UpdateCompanyAccountDto } from './company-accounts.dto';
import { CompanyAccount } from './company-accounts.entity';

const midday = (date: string) => new Date(`${date}T12:00:00Z`);
const FIELDS = ['nameUsed', 'companyEmail', 'ringCentralNumber', 'ringCentralExtension'] as const;

/**
 * Accounts at other companies (section 33, approved 2026-11-13). Managers record them from a file when adding people; after
 * that only IT and administrators change them. Events hold field names and statuses, never emails or numbers. A change
 * while IT is removing someone's access updates IT's checklist.
 */
@Injectable()
export class CompanyAccountsService {
 constructor(private readonly db: DataSource, private readonly config: ConfigService) {}
 private get fictionalOnly() { return !(this.config.get('NODE_ENV') === 'production' || this.config.get('DEPLOYMENT_PURPOSE') === 'production'); }

 accounts(memberId: string) { return memberCompanyAccounts(this.db.manager, memberId); }

 async add(user: User, dto: AddCompanyAccountDto) {
  this.check(dto);
  return this.write(async em => {
   const member = await em.getRepository(DispatchMember).findOne({ where: { id: dto.memberId }, lock: { mode: 'pessimistic_write' } });
   if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
   const account = await addCompanyAccount(em, user.id, member.id, { mcId: dto.mcId ?? null, companyName: dto.companyName ?? null, nameUsed: dto.nameUsed || null, companyEmail: dto.companyEmail || null,
    ringCentralNumber: dto.ringCentralNumber || null, ringCentralExtension: dto.ringCentralExtension || null, status: dto.status ?? 'ACTIVE', closedOn: dto.closedOn ?? null, sourceName: null });
   member.version += 1; await em.save(member);
   await refreshRemovalAccounts(em, member.id, user.id);
   return { id: account.id, version: account.version };
  });
 }

 async update(user: User, id: string, dto: UpdateCompanyAccountDto) {
  this.check(dto);
  return this.write(async em => {
   const found = await em.getRepository(CompanyAccount).findOneBy({ id });
   if (!found) throw new NotFoundException('This account no longer exists.');
   // The member first, then the account: the order adding one takes them in.
   const member = await em.getRepository(DispatchMember).findOne({ where: { id: found.memberId }, lock: { mode: 'pessimistic_write' } });
   const account = await em.getRepository(CompanyAccount).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
   if (!member || !account) throw new NotFoundException('This account no longer exists.');
   if (account.version !== dto.version) throw new ConflictException('Someone else changed this account. Reload and try again.');
   if (account.status === 'CLOSED' && dto.status !== 'ACTIVE' && dto.status !== 'KEPT_FOR_LOAD_BOARDS') throw new ConflictException('This account is closed. It’s kept as history.');
   const fields: string[] = [];
   for (const field of FIELDS) {
    const value = dto[field] === undefined ? undefined : dto[field] || null;
    if (value !== undefined && value !== account[field]) { account[field] = value; fields.push(field); }
   }
   if (!account.companyEmail && !account.ringCentralNumber) throw new BadRequestException('An account needs its company email or RingCentral number.');
   if (fields.includes('companyEmail') && account.companyEmail && account.status !== 'CLOSED') await checkEmailFree(em, account.companyEmail, member.id);
   const status = dto.status && dto.status !== account.status ? dto.status : null;
   if (status === 'CLOSED') { this.closedDay(dto.closedOn!); Object.assign(account, { status, closedAt: midday(dto.closedOn!), closedBy: user.id }); }
   else if (status) {
    if (account.status === 'CLOSED' && account.companyEmail) await checkEmailFree(em, account.companyEmail, member.id);
    Object.assign(account, { status, closedAt: null, closedBy: null });
   }
   if (!fields.length && !status) return { id, version: account.version };
   account.version += 1; await em.save(account);
   member.version += 1; await em.save(member);
   await em.getRepository(DispatchEvent).save({ memberId: member.id, teamId: null, event: 'COMPANY_ACCOUNT_CHANGED', actorId: user.id, metadata: { fields, ...(status ? { status } : {}) } });
   await refreshRemovalAccounts(em, member.id, user.id);
   return { id, version: account.version };
  });
 }

 private check(dto: { companyEmail?: string; ringCentralNumber?: string }) {
  if (dto.companyEmail && this.fictionalOnly && !dto.companyEmail.endsWith('@example.test')) throw new BadRequestException('Outside production, the company email must be a fictional example.test address.');
 }
 private closedDay(day: string) {
  if (day > usDay('latest')) throw new BadRequestException('The day it closed can’t be in the future.');
  if (day < '1980-01-01') throw new BadRequestException('That day is too long ago.');
 }
 private async write<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
  try { return await this.db.transaction(work); }
  catch (error) {
   const driver = error instanceof QueryFailedError ? error.driverError as { code?: string; constraint?: string } : null;
   if (driver?.code === '23505' && driver.constraint === 'UQ_member_company_accounts_email') throw new ConflictException('Someone else in the workspace already has this company email.');
   throw error;
  }
 }
}

export interface NewCompanyAccount { mcId: string | null; companyName: string | null; nameUsed: string | null; companyEmail: string | null; ringCentralNumber: string | null; ringCentralExtension: string | null;
 status: 'ACTIVE' | 'KEPT_FOR_LOAD_BOARDS' | 'CLOSED'; closedOn: string | null; sourceName: string | null }
/**
 * Records an account at another company for someone (the caller locked their member row), from an administrator's form or a
 * file. An open email must be free; the MC must exist (archived is fine). Writes COMPANY_ACCOUNT_ADDED.
 */
export async function addCompanyAccount(em: EntityManager, actorId: string, memberId: string, input: NewCompanyAccount) {
 if (!input.companyEmail && !input.ringCentralNumber) throw new BadRequestException('An account needs its company email or RingCentral number.');
 if (!input.mcId === !input.companyName) throw new BadRequestException('Choose the company: an MC from the list, or another company’s name.');
 if (input.mcId && !(await em.query(`SELECT 1 FROM mcs WHERE id = $1`, [input.mcId])).length) throw new BadRequestException('Choose an MC from the list.');
 if (input.status === 'CLOSED' && (!input.closedOn || input.closedOn > usDay('latest'))) throw new BadRequestException('Enter the day it closed, today or earlier.');
 if (input.companyEmail && input.status !== 'CLOSED') await checkEmailFree(em, input.companyEmail, memberId);
 const account = await em.getRepository(CompanyAccount).save({ memberId, mcId: input.mcId, companyName: input.companyName, nameUsed: input.nameUsed, companyEmail: input.companyEmail, ringCentralNumber: input.ringCentralNumber,
  ringCentralExtension: input.ringCentralExtension, status: input.status, closedAt: input.status === 'CLOSED' ? midday(input.closedOn!) : null, closedBy: input.status === 'CLOSED' ? actorId : null, sourceName: input.sourceName, createdBy: actorId });
 await em.getRepository(DispatchEvent).save({ memberId, teamId: null, event: 'COMPANY_ACCOUNT_ADDED', actorId,
  metadata: { status: input.status, fields: FIELDS.filter(field => input[field]), from: input.sourceName ? 'file' : 'form' } });
 return account;
}
