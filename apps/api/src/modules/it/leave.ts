import { EntityManager, IsNull } from 'typeorm';
import { NotificationsService } from '../updates/notifications.service';
import { ItLeaveActivity, ItLeaveRequest, ItLeaveTask, LEAVE_CHECKLIST, type LeaveKind, type LeaveProfile } from './it.entity';

/**
 * Leave (section 35, designed and approved 2026-11-11): IT's suspend checklist when someone goes on leave, and the restore
 * checklist when they're back. Only the accounts they have get a task. Called in the transaction that records or ends the
 * leave; returns the alert ids to send after it commits.
 */
export async function createLeaveRequest(em: EntityManager, alerts: NotificationsService, input: { leaveId: string; memberId: string; kind: LeaveKind; keys: string[]; profile: LeaveProfile; dueOn: string; managerId: string; actorId: string | null }) {
 const keys = LEAVE_CHECKLIST.filter(task => input.keys.includes(task.key)).map(task => task.key);
 if (!keys.length) return [];
 const request = await em.getRepository(ItLeaveRequest).save({ leaveId: input.leaveId, memberId: input.memberId, kind: input.kind, managerId: input.managerId, profile: input.profile, dueOn: input.dueOn, version: 0, completedAt: null, cancelledAt: null });
 await em.getRepository(ItLeaveTask).save(keys.map(key => ({ requestId: request.id, key, status: 'PENDING' as const, notes: '' })));
 await em.getRepository(ItLeaveActivity).save({ requestId: request.id, actorId: input.actorId, event: input.kind === 'SUSPEND' ? 'SUSPEND_REQUEST_CREATED' : 'RESTORE_REQUEST_CREATED', metadata: { tasks: keys.join(',') } });
 return alerts.queueItLeave(em, request, input.kind === 'SUSPEND' ? 'IT_LEAVE_SUSPEND' : 'IT_LEAVE_RESTORE');
}

/**
 * A leave's suspend checklist, locked, with its tasks: the open one, or with `anyState` also a cancelled one (a leave has at
 * most one). toRestore is what IT may have changed: completed, or started (in progress, blocked or with notes), because
 * forwarding or an auto-reply can be on before the task is marked completed.
 */
export async function lockSuspend(em: EntityManager, leaveId: string, anyState = false) {
 const request = await em.getRepository(ItLeaveRequest).findOne({ where: { leaveId, kind: 'SUSPEND', ...(anyState ? {} : { cancelledAt: IsNull() }) }, lock: { mode: 'pessimistic_write' } });
 const tasks = request ? await em.getRepository(ItLeaveTask).findBy({ requestId: request.id }) : [];
 return { request, tasks, completed: tasks.filter(task => task.status === 'COMPLETED').map(task => task.key),
  toRestore: tasks.filter(task => task.status !== 'NOT_NEEDED' && (task.status !== 'PENDING' || task.notes.trim())).map(task => task.key) };
}

/** Stops an unfinished suspend checklist: the leave ended before IT finished. Kept for history, out of every list. */
export async function cancelLeaveRequest(em: EntityManager, request: ItLeaveRequest, actorId: string | null, why: string) {
 if (request.completedAt || request.cancelledAt) return;
 request.cancelledAt = new Date(); request.version += 1; await em.save(request);
 await em.getRepository(ItLeaveActivity).save({ requestId: request.id, actorId, event: 'CANCELLED', metadata: { why } });
}
