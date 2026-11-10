import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { NotificationsService } from '../updates/notifications.service';
import { In, IsNull } from 'typeorm';
import { ItOnboardingActivity, ItOnboardingRequest, ItOnboardingTask, ItRemovalActivity, ItRemovalRequest, ItRemovalTask, REMOVAL_CHECKLIST } from './it.entity';

/** Every setup of a dispatcher record: a new dispatcher's (by their application) and a support's (by the member), as two indexed lookups. */
const MEMBER_SETUP_IDS = `SELECT x.id FROM it_onboarding_requests x WHERE x."memberId" = :memberId
 UNION SELECT x.id FROM it_onboarding_requests x JOIN dispatch_members d ON d."applicationId" = x."applicationId" WHERE d.id = :memberId`;

/**
 * Locks every IT setup request of a dispatcher record (none cancelled), newest first: a new dispatcher's setup from their
 * application, and the setups a manager asked for while they were a support or updater (section 32). Called before the
 * member row is locked, the order IT completion uses (request, then the member it activates), so leaving can't deadlock.
 * Leaving and promotion both take it, and call sameSetups once the member is locked.
 */
export async function lockSetupRequests(em: EntityManager, memberId: string) {
 return em.getRepository(ItOnboardingRequest).createQueryBuilder('r').setLock('pessimistic_write')
  .where(`r."cancelledAt" IS NULL AND r.id IN (${MEMBER_SETUP_IDS})`, { memberId }).orderBy('r.createdAt', 'DESC').getMany();
}
/**
 * Called once the member row is locked. A setup asked for after lockSetupRequests read the list (its writer held the member
 * lock and committed while this waited) would otherwise be missed and stay open with nothing to remove it. Nothing can add
 * one now, so this re-reads without locking (locking after the member could deadlock with IT) and asks for a reload.
 */
export async function sameSetups(em: EntityManager, memberId: string, locked: Pick<ItOnboardingRequest, 'id'>[]) {
 const now = await em.getRepository(ItOnboardingRequest).createQueryBuilder('r').select('r.id')
  .where(`r."cancelledAt" IS NULL AND r.id IN (${MEMBER_SETUP_IDS})`, { memberId }).getMany();
 if (now.some(row => !locked.some(item => item.id === row.id))) throw new ConflictException('Someone just asked IT to set something up for them. Reload and try again.');
}
/** The same setups without a lock, plus the one a removal names (cancelled when they left), newest first. */
export async function memberSetups(em: EntityManager, memberId: string, include: string | null = null) {
 return em.getRepository(ItOnboardingRequest).createQueryBuilder('r')
  .where(`(r."cancelledAt" IS NULL OR r.id = :include) AND r.id IN (${MEMBER_SETUP_IDS})`, { memberId, include: include ?? '00000000-0000-0000-0000-000000000000' })
  .orderBy('r.createdAt', 'DESC').getMany();
}
/** The accounts IT set up across those requests: for each, the newest one recorded. The dispatcher page and IT's removal both use this. */
export function setupAccounts(setups: Pick<ItOnboardingRequest, 'companyEmail' | 'assignedRingCentralPhoneNumber' | 'ringCentralExtension' | 'datEmail' | 'truckstopEmail'>[]) {
 const first = <K extends 'companyEmail' | 'assignedRingCentralPhoneNumber' | 'ringCentralExtension' | 'datEmail' | 'truckstopEmail'>(key: K) => setups.find(setup => setup[key])?.[key] ?? null;
 return { companyEmail: first('companyEmail'), ringCentralNumber: first('assignedRingCentralPhoneNumber'), ringCentralExtension: first('ringCentralExtension'), datEmail: first('datEmail'), truckstopEmail: first('truckstopEmail') };
}

/**
 * The removal checklist for someone leaving. A dispatcher's is the full list. A support's lists only what they had: the
 * company email and RingCentral number recorded or asked for, business software if a sign-in was recorded or IT set it up,
 * equipment if IT set it up, and always the Dispatch group and shared passwords, as before section 32.
 */
export async function removalTaskKeys(em: EntityManager, position: 'DISPATCHER' | 'SUPPORT', setups: Pick<ItOnboardingRequest, 'id'>[], accounts: { companyEmail: string | null; ringCentralNumber: string | null; datEmail?: string | null; truckstopEmail?: string | null } | undefined) {
 if (position !== 'SUPPORT') return REMOVAL_CHECKLIST.map(task => task.key);
 const asked: string[] = setups.length ? (await em.query(`SELECT DISTINCT key FROM it_onboarding_tasks WHERE "requestId" = ANY($1)`, [setups.map(setup => setup.id)])).map((row: { key: string }) => row.key) : [];
 const keys = new Set(['DISPATCH_GROUP', 'SHARED_PASSWORDS']);
 if (accounts?.companyEmail || asked.includes('GOOGLE_WORKSPACE')) keys.add('GOOGLE_WORKSPACE');
 if (accounts?.ringCentralNumber || asked.includes('RINGCENTRAL')) keys.add('RINGCENTRAL');
 if (accounts?.datEmail || accounts?.truckstopEmail || asked.includes('BUSINESS_SOFTWARE')) keys.add('BUSINESS_SOFTWARE');
 if (asked.includes('EQUIPMENT')) keys.add('EQUIPMENT');
 return REMOVAL_CHECKLIST.filter(task => keys.has(task.key)).map(task => task.key);
}

/**
 * A promoted support's IT setups (section 32), in the promotion transaction: what IT recorded fills the new dispatcher
 * setup, a task IT completed there shows as done (an account task only with its account recorded), and an open setup is
 * cancelled, so IT works one checklist and never makes a second mailbox. The caller locked the setups (lockSetupRequests)
 * before the member row, the order leaving uses, and checked sameSetups, so this takes no new locks.
 */
export async function carrySupportSetups(em: EntityManager, request: ItOnboardingRequest, memberId: string, actorId: string) {
 const setups = await em.getRepository(ItOnboardingRequest).find({ where: { memberId, purpose: 'SUPPORT', cancelledAt: IsNull() }, order: { createdAt: 'DESC' } });
 if (!setups.length) return;
 const accounts = setupAccounts(setups);
 Object.assign(request, { companyEmail: accounts.companyEmail, assignedRingCentralPhoneNumber: accounts.ringCentralNumber, ringCentralExtension: accounts.ringCentralExtension, datEmail: accounts.datEmail, truckstopEmail: accounts.truckstopEmail });
 await em.getRepository(ItOnboardingRequest).save(request);
 const done: string[] = (await em.query(`SELECT DISTINCT key FROM it_onboarding_tasks WHERE "requestId" = ANY($1) AND status = 'COMPLETED'`, [setups.map(setup => setup.id)])).map((row: { key: string }) => row.key)
  .filter((key: string) => (key !== 'GOOGLE_WORKSPACE' || !!accounts.companyEmail) && (key !== 'RINGCENTRAL' || !!accounts.ringCentralNumber));
 if (done.length) await em.getRepository(ItOnboardingTask).update({ requestId: request.id, key: In(done) }, { status: 'COMPLETED', updatedBy: actorId });
 await em.getRepository(ItOnboardingActivity).save({ requestId: request.id, actorId, event: 'SUPPORT_SETUP_CARRIED', metadata: { tasks: done.join(',') } });
 for (const setup of setups.filter(item => !item.completedAt)) {
  setup.cancelledAt = new Date(); setup.version += 1; await em.getRepository(ItOnboardingRequest).save(setup);
  await em.getRepository(ItOnboardingActivity).save({ requestId: setup.id, actorId, event: 'CANCELLED_BY_PROMOTION', metadata: {} });
 }
}

/**
 * In the transaction that records a dispatcher's last day (designed and approved 2026-11-02): opens the IT removal
 * checklist, the reverse of setup, due by the end of their last day, and queues an alert for IT: "access to remove" when the
 * day has come, "removal scheduled" for a future day (the last-day job alerts again then). An unfinished setup request is
 * cancelled so it leaves the queue; notice for a future day needs finished setup. The person leaving is never messaged.
 * Returns the alert ids to send after commit.
 */
export async function createRemoval(em: EntityManager, alerts: NotificationsService, input: {
 setup: ItOnboardingRequest | null; taskKeys?: string[]; accounts?: { companyEmail: string | null; ringCentralNumber: string | null; ringCentralExtension?: string | null; datEmail?: string | null; truckstopEmail?: string | null }; position: string; memberId: string; name: string; dueOn: string; scheduled: boolean; emailAfter: 'FORWARD' | 'SUSPEND'; actorId: string;
 mcName: string | null; teamName: string | null;
}) {
 const { setup } = input;
 // Someone recorded by hand has no setup request: IT works from the accounts their manager recorded.
 const companyEmail = setup?.companyEmail ?? input.accounts?.companyEmail ?? null, ringCentralNumber = setup?.assignedRingCentralPhoneNumber ?? input.accounts?.ringCentralNumber ?? null;
 if (setup && !setup.completedAt) { setup.cancelledAt = new Date(); setup.version += 1; await em.save(setup); }
 // Forwarding needs a mailbox: without a company email there is nothing to forward.
 const forward = input.emailAfter === 'FORWARD' && !!companyEmail;
 const removal = await em.getRepository(ItRemovalRequest).save({
  memberId: input.memberId, setupRequestId: setup?.id ?? null, managerId: input.actorId, createdBy: input.actorId,
  profile: { displayName: setup?.profile.proposedDisplayName ?? input.name, position: input.position, companyEmail, ringCentralNumber, noSetupRecord: !setup,
   ringCentralExtension: setup?.ringCentralExtension ?? input.accounts?.ringCentralExtension ?? null, datEmail: setup?.datEmail ?? input.accounts?.datEmail ?? null, truckstopEmail: setup?.truckstopEmail ?? input.accounts?.truckstopEmail ?? null,
   mcName: input.mcName, teamName: input.teamName, setUpAt: setup?.completedAt?.toISOString() ?? null },
  emailAfter: forward ? 'FORWARD' : 'SUSPEND', forwardTo: forward ? input.actorId : null,
  dueOn: input.dueOn, numberOutcome: null, version: 0, completedAt: null, dueAlertedAt: input.scheduled ? null : new Date() });
 await em.getRepository(ItRemovalTask).save(REMOVAL_CHECKLIST.filter(task => !input.taskKeys || input.taskKeys.includes(task.key)).map(task => ({ requestId: removal.id, key: task.key, status: 'PENDING' as const, notes: '' })));
 await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId: input.actorId, event: 'REMOVAL_REQUEST_CREATED', metadata: { setupCancelled: !!setup && !setup.completedAt, noSetupRecord: !setup } });
 return input.scheduled ? alerts.queueItRemoval(em, removal, 'IT_REMOVAL_SCHEDULED') : alerts.queueItRemoval(em, removal, 'IT_REMOVAL_WAITING');
}
