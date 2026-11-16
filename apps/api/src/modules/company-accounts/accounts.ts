import { ConflictException } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { ItRemovalActivity, ItRemovalRequest, ItRemovalTask, type RemovalCompanyAccount } from '../it/it.entity';
import { alreadyHere } from '../onboarding/already-here';
import type { AccountStatus } from './company-accounts.entity';

type Query = Pick<EntityManager, 'query'>;
/** An account at another company as people read it, with the load board seats its email signs in to. */
export interface CompanyAccountView {
 id: string; mcId: string | null; mc: string | null; mcArchived: boolean; companyName: string | null; nameUsed: string | null; companyEmail: string | null; ringCentralNumber: string | null;
 ringCentralExtension: string | null; status: AccountStatus; closedAt: string | null; sourceName: string | null; version: number; createdAt: string; keptFor: string[];
}
/** Someone's accounts at other companies, open ones first. keptFor names the seats (still open) their email signs in to. */
export async function memberCompanyAccounts(em: Query, memberId: string): Promise<CompanyAccountView[]> {
 return em.query(`SELECT c.id, c."mcId", m.name AS mc, m."archivedAt" IS NOT NULL AS "mcArchived", c."companyName", c."nameUsed", c."companyEmail", c."ringCentralNumber", c."ringCentralExtension",
   c.status, c."closedAt", c."sourceName", c.version, c."createdAt",
   coalesce((SELECT array_agg(DISTINCT a.name) FROM member_load_board_seats s JOIN load_board_accounts a ON a.id = s."accountId"
     WHERE s.status <> 'ENDED' AND c."companyEmail" IS NOT NULL AND s."signInEmail" = lower(c."companyEmail")), '{}') AS "keptFor"
  FROM member_company_accounts c LEFT JOIN mcs m ON m.id = c."mcId" WHERE c."memberId" = $1 ORDER BY (c.status = 'CLOSED'), c."createdAt"`, [memberId]);
}
/** What IT's removal keeps of each account that isn't closed. */
export async function removalCompanyAccounts(em: Query, memberId: string): Promise<RemovalCompanyAccount[]> {
 return (await memberCompanyAccounts(em, memberId)).filter(account => account.status !== 'CLOSED')
  .map(account => ({ id: account.id, company: account.mc ?? account.companyName ?? '', nameUsed: account.nameUsed, companyEmail: account.companyEmail, ringCentralNumber: account.ringCentralNumber, ringCentralExtension: account.ringCentralExtension, status: account.status, keptFor: account.keptFor }));
}
/** An email open at another company belongs to one person, as a main company email does: refused when someone else here has it. */
export async function checkEmailFree(em: EntityManager, email: string, memberId: string) {
 const matches = (await alreadyHere(em, [{ key: 'email', email, phone: null, applicationId: null, skipMemberId: memberId }])).get('email') ?? [];
 if (matches.some(match => match.kind === 'MEMBER' && match.status !== 'LEFT')) throw new ConflictException('Someone else in the workspace already has this company email.');
}
/**
 * An open removal lists every company account that isn't closed. A change while it's open updates that list; an email or
 * number IT wasn't told about reopens Google Workspace or RingCentral if IT had completed it, and adds the step to a
 * support's checklist that lacked it.
 */
export async function refreshRemovalAccounts(em: EntityManager, memberId: string, actorId: string) {
 const removal = await em.getRepository(ItRemovalRequest).findOne({ where: { memberId, cancelledAt: IsNull(), completedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
 if (!removal) return;
 const accounts = await removalCompanyAccounts(em, memberId), profile = removal.profile, earlier = profile.companyAccounts ?? [];
 if (JSON.stringify(earlier) === JSON.stringify(accounts)) return;
 removal.profile = { ...profile, companyAccounts: accounts };
 removal.version += 1; await em.save(removal);
 const told = (field: 'companyEmail' | 'ringCentralNumber', value: string | null) => !value || value === profile[field] || earlier.some(item => item[field] === value);
 const steps = [...(accounts.some(account => !told('companyEmail', account.companyEmail)) ? ['GOOGLE_WORKSPACE'] : []), ...(accounts.some(account => !told('ringCentralNumber', account.ringCentralNumber)) ? ['RINGCENTRAL'] : [])];
 if (!steps.length) return;
 let reopened = false, added = false;
 for (const key of steps) {
  const task = await em.getRepository(ItRemovalTask).findOneBy({ requestId: removal.id, key });
  if (!task) { await em.getRepository(ItRemovalTask).save({ requestId: removal.id, key, status: 'PENDING', notes: '' }); added = true; }
  else if (task.status === 'COMPLETED') { task.status = 'PENDING'; task.updatedBy = actorId; await em.save(task); reopened = true; }
 }
 await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId, event: 'ACCOUNTS_CORRECTED', metadata: { reopened, added, companyAccounts: true } });
}
