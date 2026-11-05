import { EntityManager } from 'typeorm';
import { NotificationsService } from '../updates/notifications.service';
import { ItOnboardingRequest, ItRemovalActivity, ItRemovalRequest, ItRemovalTask, REMOVAL_CHECKLIST } from './it.entity';

/**
 * Locks the IT setup request of a dispatcher record, if they ever had one (supports never do). Called before the member row
 * is locked, the order IT completion uses (request, then the member it activates), so leaving can't deadlock with it.
 */
export async function lockSetupRequest(em: EntityManager, memberId: string) {
 return em.getRepository(ItOnboardingRequest).createQueryBuilder('r').setLock('pessimistic_write')
  .where(`r."applicationId" = (SELECT d."applicationId" FROM dispatch_members d WHERE d.id = :memberId)`, { memberId }).getOne();
}

/**
 * In the transaction that records a dispatcher's last day (designed and approved 2026-11-02): opens the IT removal
 * checklist, the reverse of setup, due by the end of their last day, and queues an alert for IT: "access to remove" when the
 * day has come, "removal scheduled" for a future day (the last-day job alerts again then). An unfinished setup request is
 * cancelled so it leaves the queue; notice for a future day needs finished setup. The person leaving is never messaged.
 * Returns the alert ids to send after commit.
 */
export async function createRemoval(em: EntityManager, alerts: NotificationsService, input: {
 setup: ItOnboardingRequest | null; accounts?: { companyEmail: string | null; ringCentralNumber: string | null; ringCentralExtension?: string | null; datEmail?: string | null; truckstopEmail?: string | null }; position: string; memberId: string; name: string; dueOn: string; scheduled: boolean; emailAfter: 'FORWARD' | 'SUSPEND'; actorId: string;
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
 await em.getRepository(ItRemovalTask).save(REMOVAL_CHECKLIST.map(task => ({ requestId: removal.id, key: task.key, status: 'PENDING' as const, notes: '' })));
 await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId: input.actorId, event: 'REMOVAL_REQUEST_CREATED', metadata: { setupCancelled: !!setup && !setup.completedAt, noSetupRecord: !setup } });
 return input.scheduled ? alerts.queueItRemoval(em, removal, 'IT_REMOVAL_SCHEDULED') : alerts.queueItRemoval(em, removal, 'IT_REMOVAL_WAITING');
}
