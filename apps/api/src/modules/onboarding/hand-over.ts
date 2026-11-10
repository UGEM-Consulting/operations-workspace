import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Role, User, UserStatus } from '../users/user.entity';
import { ApplicationActivity, ApplicationManagerChange, DispatcherApplication, Invitation } from './entities';

/** Roles that can be responsible for an invitation and its application. */
export const RESPONSIBLE_ROLES = [Role.DISPATCHER_MANAGER, Role.SYSTEM_ADMIN];

/**
 * The new responsible manager: an active dispatch manager or administrator. Read FOR SHARE in the caller's transaction,
 * so an account change waits for this record and sees it among their open records, or this sees the change and refuses.
 */
export async function responsibleManager(em: EntityManager, id: string) {
 const user = await em.getRepository(User).findOne({ where: { id }, lock: { mode: 'pessimistic_read' } });
 if (!user || user.status !== UserStatus.ACTIVE || !RESPONSIBLE_ROLES.includes(user.role)) throw new BadRequestException('Choose an active dispatch manager or administrator.');
 return user;
}

/**
 * A manager's open records, which move together when their account is deactivated or their role changes: invitations not
 * used yet (still valid: neither revoked nor expired), applications in progress or awaiting review, those waiting for the applicant's changes, and approvals whose
 * IT setup isn't finished (so the setup notice reaches someone). Finished applications stay with them for the record, as does
 * the unfinished paperwork of someone who left (a revoked catch-up link): nothing more can happen to it.
 */
const OPEN_RECORDS = `SELECT a.id, a."invitationId", CASE
  WHEN a.status = 'INVITED' THEN 'invitations' WHEN a.status IN ('DRAFT','SUBMITTED','RESUBMITTED') THEN 'applications'
  WHEN a.status = 'CHANGES_REQUESTED' THEN 'changes' ELSE 'itSetup' END AS bucket
 FROM dispatcher_applications a JOIN invitations i ON i.id = a."invitationId" WHERE a."assignedManagerId" = $1
  AND NOT (i."catchUpMemberId" IS NOT NULL AND i."revokedAt" IS NOT NULL) AND (a.status <> 'INVITED' OR (i."revokedAt" IS NULL AND i."expiresAt" > now())) AND (a.status NOT IN ('APPROVED','REJECTED')
  OR (a.status = 'APPROVED' AND EXISTS (SELECT 1 FROM it_onboarding_requests r WHERE r."applicationId" = a.id AND r."completedAt" IS NULL AND r."cancelledAt" IS NULL)))`;
/** Unfinished IT removals that send them the completion notice or new mail from the mailbox of someone who left. */
const OPEN_REMOVALS = `FROM it_removal_requests r WHERE (r."managerId" = $1 OR r."forwardTo" = $1) AND r."completedAt" IS NULL AND r."cancelledAt" IS NULL`;
/** Unfinished setups they asked IT for a support or updater (section 32): the completion notice goes to them. */
const OPEN_SUPPORT_SETUPS = `FROM it_onboarding_requests r WHERE r.purpose = 'SUPPORT' AND r."managerId" = $1 AND r."completedAt" IS NULL AND r."cancelledAt" IS NULL`;
export async function openRecords(em: EntityManager, userId: string) {
 const rows: { id: string; invitationId: string; bucket: 'invitations' | 'applications' | 'changes' | 'itSetup' }[] = await em.query(OPEN_RECORDS, [userId]);
 const [{ removals }]: { removals: number }[] = await em.query(`SELECT count(*)::integer AS removals ${OPEN_REMOVALS}`, [userId]);
 const [{ supportSetups }]: { supportSetups: number }[] = await em.query(`SELECT count(*)::integer AS "supportSetups" ${OPEN_SUPPORT_SETUPS}`, [userId]);
 const count = (bucket: string) => rows.filter(row => row.bucket === bucket).length;
 return { rows, counts: { invitations: count('invitations'), applications: count('applications'), changes: count('changes'), itSetup: count('itSetup') + supportSetups, removals, total: rows.length + removals + supportSetups } };
}

/**
 * Makes `toId` responsible for one application: its invitation, the application and an unfinished IT setup request, so the
 * new manager reviews, decides and gets the setup notice. The caller holds the invitation lock. The applicant isn't told.
 */
export async function moveApplication(em: EntityManager, input: { applicationId: string; invitationId: string; fromId: string; toId: string; actorId: string; reason: 'CHANGED' | 'HANDED_OVER'; note: string | null }) {
 await em.update(Invitation, { id: input.invitationId }, { managerId: input.toId });
 await em.update(DispatcherApplication, { id: input.applicationId }, { assignedManagerId: input.toId });
 await em.query(`UPDATE it_onboarding_requests SET "managerId" = $2, "updatedAt" = now() WHERE "applicationId" = $1 AND "completedAt" IS NULL AND "cancelledAt" IS NULL`, [input.applicationId, input.toId]);
 // A support's setup asked at approval names no application: it follows the person's record, when it was this manager's.
 await moveSupportSetups(em, input.fromId, input.toId, input.actorId, input.reason === 'CHANGED' ? 'MANAGER_CHANGED' : 'MANAGER_HANDED_OVER', input.applicationId);
 await em.getRepository(ApplicationManagerChange).save({ applicationId: input.applicationId, fromUserId: input.fromId, toUserId: input.toId, actorId: input.actorId, reason: input.reason, note: input.note });
 await em.getRepository(ApplicationActivity).save({ invitationId: input.invitationId, actorId: input.actorId, event: input.reason === 'CHANGED' ? 'MANAGER_CHANGED' : 'MANAGER_HANDED_OVER' });
}

/** In the account change that deactivates a manager or changes their role: every open record moves to `toId` together. */
export async function handOver(em: EntityManager, fromId: string, toId: string, actorId: string) {
 if (fromId === toId) throw new BadRequestException('Choose someone else to take over their records.');
 await responsibleManager(em, toId);
 // Invitation rows first, as every application write does, in a fixed order.
 const { rows } = await openRecords(em, fromId);
 const ids = rows.map(row => row.invitationId).sort();
 if (ids.length) await em.query(`SELECT id FROM invitations WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids]);
 // Re-read under the locks: only records still owned and open move.
 const open = (await openRecords(em, fromId)).rows;
 for (const row of open) await moveApplication(em, { applicationId: row.id, invitationId: row.invitationId, fromId, toId, actorId, reason: 'HANDED_OVER', note: null });
 return open.length + await moveRemovals(em, fromId, toId, actorId) + await moveSupportSetups(em, fromId, toId, actorId, 'MANAGER_HANDED_OVER');
}

/**
 * Open support setups whose completion notice goes to fromId (all of them, or one person's when their application's manager
 * changes): each is locked, moves and says so in IT's history, so an IT page open meanwhile knows why it must reload.
 */
async function moveSupportSetups(em: EntityManager, fromId: string, toId: string, actorId: string, event: 'MANAGER_CHANGED' | 'MANAGER_HANDED_OVER', applicationId?: string) {
 const setups: { id: string }[] = applicationId
  ? await em.query(`SELECT r.id ${OPEN_SUPPORT_SETUPS} AND r."memberId" IN (SELECT id FROM dispatch_members WHERE "applicationId" = $2) ORDER BY r.id FOR UPDATE OF r`, [fromId, applicationId])
  : await em.query(`SELECT r.id ${OPEN_SUPPORT_SETUPS} ORDER BY r.id FOR UPDATE OF r`, [fromId]);
 for (const setup of setups) {
  await em.query(`UPDATE it_onboarding_requests SET "managerId" = $2, version = version + 1, "updatedAt" = now() WHERE id = $1`, [setup.id, toId]);
  await em.query(`INSERT INTO it_onboarding_activity ("requestId","actorId",event,metadata) VALUES ($1,$2,$3,'{}')`, [setup.id, actorId, event]);
 }
 return setups.length;
}

/**
 * Open removals follow too: the completion notice, and new mail if it was going to them. Activity records whether the
 * forwarding target changed after IT started on the email task, so the checklist can ask IT to change what they set up.
 */
async function moveRemovals(em: EntityManager, fromId: string, toId: string, actorId: string) {
 const removals: { id: string; forwardTo: string | null; started: boolean }[] = await em.query(`SELECT r.id, r."forwardTo",
   EXISTS (SELECT 1 FROM it_removal_tasks t WHERE t."requestId" = r.id AND t.key = 'GOOGLE_WORKSPACE' AND t.status <> 'PENDING') AS started
  ${OPEN_REMOVALS} ORDER BY r.id FOR UPDATE OF r`, [fromId]);
 for (const removal of removals) {
  const forwardChanged = removal.forwardTo === fromId;
  await em.query(`UPDATE it_removal_requests SET "managerId" = CASE WHEN "managerId" = $2 THEN $3::uuid ELSE "managerId" END, "forwardTo" = CASE WHEN "forwardTo" = $2 THEN $3::uuid ELSE "forwardTo" END,
    version = version + 1, "updatedAt" = now() WHERE id = $1`, [removal.id, fromId, toId]);
  await em.query(`INSERT INTO it_removal_activity ("requestId","actorId",event,metadata) VALUES ($1,$2,'MANAGER_HANDED_OVER',$3)`, [removal.id, actorId, { forwardChanged, forwardingStarted: forwardChanged && removal.started }]);
 }
 return removals.length;
}
