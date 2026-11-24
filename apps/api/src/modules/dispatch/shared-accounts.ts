import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { phoneKey, phoneSqlOf } from '../onboarding/already-here';
import { ItRemovalActivity, ItRemovalRequest, ItRemovalTask, forgetDone, handedOver } from '../it/it.entity';
import { DispatchEvent, MemberSharedAccount, type SharedKind } from './dispatch.entity';

type Query = Pick<EntityManager, 'query'>;
/** Someone here now whose record holds a company email or RingCentral number. onRecord: only a manager recorded it by hand (no IT setup, other company's account or hand-over holds it), so it can be moved to someone else. */
export interface AccountOwner { memberId: string; name: string; onRecord: boolean }
export interface SharedUse { id: string; kind: SharedKind; value: string; owner: { id: string; name: string } | null; since: string; handedOver: boolean }
export interface SharedUsedBy { kind: SharedKind; value: string; users: { id: string; name: string }[] }

/** The same value for comparing: an email in lower case, a number by its digits (without a leading US 1). */
export const sharedKey = (kind: SharedKind, value: string) => kind === 'EMAIL' ? value.trim().toLowerCase() : phoneKey(value) ?? '';
const label = (kind: SharedKind) => kind === 'EMAIL' ? 'company email' : 'RingCentral number';

/**
 * Who owns a company email or RingCentral number among people here now (section 35): what a manager recorded, what IT
 * recorded on a setup, an account at another of our companies, or one handed over to them. Someone only using it isn't an owner.
 */
export async function accountOwners(em: Query, kind: SharedKind, value: string, exceptMemberId: string | null = null): Promise<AccountOwner[]> {
 const key = sharedKey(kind, value);
 if (!key) return [];
 const match = (expr: string) => kind === 'EMAIL' ? `lower(${expr}) = $1` : `${phoneSqlOf(expr)} = $1`;
 const [recorded, setup, account] = kind === 'EMAIL' ? ['e."companyEmail"', 'r."companyEmail"', 'x."companyEmail"'] : ['e."ringCentralNumber"', 'r."assignedRingCentralPhoneNumber"', 'x."ringCentralNumber"'];
 return em.query(`SELECT d.id AS "memberId", d."firstName" || ' ' || d."lastName" AS name, bool_and(o."onRecord") AS "onRecord" FROM (
   SELECT e."memberId", true AS "onRecord" FROM existing_member_records e WHERE ${match(recorded)}
   UNION ALL SELECT r."memberId", false FROM it_onboarding_requests r WHERE r."memberId" IS NOT NULL AND r."cancelledAt" IS NULL AND ${match(setup)}
   UNION ALL SELECT d.id, false FROM it_onboarding_requests r JOIN dispatch_members d ON d."applicationId" = r."applicationId" WHERE r."cancelledAt" IS NULL AND ${match(setup)}
   UNION ALL SELECT x."memberId", false FROM member_company_accounts x WHERE x.status <> 'CLOSED' AND ${match(account)}
   UNION ALL SELECT s."memberId", false FROM member_shared_accounts s WHERE s.kind = $2 AND s."handedOverAt" IS NOT NULL AND s."endedAt" IS NULL AND ${match('s.value')}
  ) o JOIN dispatch_members d ON d.id = o."memberId" WHERE d.status <> 'LEFT' AND d.id IS DISTINCT FROM $3::uuid
  GROUP BY d.id ORDER BY lower(d."firstName"), lower(d."lastName")`, [key, kind, exceptMemberId]);
}

/** What someone uses that is another person's, and who uses what is theirs, for their page. */
export async function memberSharing(em: Query, memberId: string): Promise<{ uses: SharedUse[]; usedBy: SharedUsedBy[] }> {
 const uses: SharedUse[] = await em.query(`SELECT s.id, s.kind, s.value, CASE WHEN o.id IS NULL THEN NULL ELSE json_build_object('id', o.id, 'name', o."firstName" || ' ' || o."lastName") END AS owner,
   coalesce(s."handedOverAt", s."createdAt") AS since, s."handedOverAt" IS NOT NULL AS "handedOver"
  FROM member_shared_accounts s LEFT JOIN dispatch_members o ON o.id = s."ownerMemberId" WHERE s."memberId" = $1 AND s."endedAt" IS NULL ORDER BY s.kind`, [memberId]);
 const users: { kind: SharedKind; value: string; id: string; name: string }[] = await em.query(`SELECT s.kind, s.value, u.id, u."firstName" || ' ' || u."lastName" AS name
  FROM member_shared_accounts s JOIN dispatch_members u ON u.id = s."memberId" WHERE s."ownerMemberId" = $1 AND s."endedAt" IS NULL AND s."handedOverAt" IS NULL
  ORDER BY s.kind, lower(u."firstName"), lower(u."lastName")`, [memberId]);
 const usedBy: SharedUsedBy[] = [];
 for (const row of users) {
  const found = usedBy.find(item => item.kind === row.kind && sharedKey(item.kind, item.value) === sharedKey(row.kind, row.value));
  if (found) found.users.push({ id: row.id, name: row.name }); else usedBy.push({ kind: row.kind, value: row.value, users: [{ id: row.id, name: row.name }] });
 }
 return { uses, usedBy };
}

/**
 * Records that someone uses another person's email or number. The owner must be someone here now holding it, never the person
 * themselves. A different one of the same kind they used before ends; the same one is left as it is.
 */
export async function shareAccount(em: EntityManager, actorId: string, memberId: string, kind: SharedKind, value: string, ownerId: string) {
 if (ownerId === memberId) throw new BadRequestException(`This is their own ${label(kind)}.`);
 const owners = await accountOwners(em, kind, value, memberId);
 if (!owners.some(owner => owner.memberId === ownerId)) throw new ConflictException(`That ${label(kind)} isn’t theirs any more. Reload and try again.`);
 const repo = em.getRepository(MemberSharedAccount), open = await repo.findOne({ where: { memberId, kind, endedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
 if (open?.handedOverAt) throw new ConflictException(`They own a ${label(kind)} that was handed over to them. Change it from IT’s side.`);
 if (open && open.ownerMemberId === ownerId && sharedKey(kind, open.value) === sharedKey(kind, value)) return false;
 if (open) await endRow(em, actorId, open, 'STOPPED');
 await repo.save({ memberId, ownerMemberId: ownerId, kind, value: kind === 'EMAIL' ? value.trim().toLowerCase() : value.trim(), createdBy: actorId, handedOverAt: null, endedAt: null, endedBy: null, endedHow: null });
 await em.getRepository(DispatchEvent).save({ memberId, teamId: null, event: 'ACCOUNT_SHARED', actorId, metadata: { kind } });
 await refreshRemovalSharing(em, [memberId, ownerId], actorId);
 return true;
}
/** Ends someone's use of another person's email or number of this kind, if any. */
export async function stopSharing(em: EntityManager, actorId: string, memberId: string, kind: SharedKind) {
 const open = await em.getRepository(MemberSharedAccount).findOne({ where: { memberId, kind, endedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
 if (!open || open.handedOverAt) return false;
 await endRow(em, actorId, open, 'STOPPED');
 await refreshRemovalSharing(em, [memberId, ...(open.ownerMemberId ? [open.ownerMemberId] : [])], actorId);
 return true;
}
async function endRow(em: EntityManager, actorId: string, row: MemberSharedAccount, how: 'STOPPED' | 'MOVED' | 'OWNER_LEFT' | 'LEFT') {
 Object.assign(row, { endedAt: new Date(), endedBy: actorId, endedHow: how });
 await em.getRepository(MemberSharedAccount).save(row);
 await em.getRepository(DispatchEvent).save({ memberId: row.memberId, teamId: null, event: 'SHARING_ENDED', actorId, metadata: { kind: row.kind, how } });
}

/**
 * Whom a leaving owner's email and number can be handed over to: someone here now using one of them. Refused when that person
 * uses a different person's email or number of a kind being handed over, since one person uses one of each.
 */
export async function checkHandOver(em: EntityManager, ownerId: string, toId: string) {
 const users = await em.getRepository(MemberSharedAccount).find({ where: { ownerMemberId: ownerId, endedAt: IsNull(), handedOverAt: IsNull() } });
 if (!users.some(row => row.memberId === toId)) throw new BadRequestException('Choose someone who uses their email or number.');
 const [left] = await em.query(`SELECT status = 'LEFT' AS left FROM dispatch_members WHERE id = $1`, [toId]);
 if (!left || left.left) throw new BadRequestException('Choose someone who still works here.');
 for (const kind of new Set(users.map(row => row.kind))) {
  const theirs = await em.getRepository(MemberSharedAccount).findOneBy({ memberId: toId, kind, endedAt: IsNull() });
  if (theirs && theirs.ownerMemberId !== ownerId) throw new ConflictException(`They already use someone else’s ${label(kind)}, so this one can’t be handed over to them.`);
 }
}

/**
 * When someone becomes Left. What they used of other people's ends. What others used of theirs is handed over to the person
 * chosen when they were marked as leaving (who owns it from now on, and the others use it as theirs), or ends with them.
 */
export async function sharingOnLeft(em: EntityManager, actorId: string, memberId: string, handOverTo: string | null) {
 const repo = em.getRepository(MemberSharedAccount);
 const used = await repo.find({ where: { memberId, endedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
 for (const row of used) await endRow(em, actorId, row, 'LEFT');
 // An owner whose removal counted on handing it to them learns they left (refreshRemovalSharing drops that hand-over).
 const owners = used.flatMap(row => row.ownerMemberId ? [row.ownerMemberId] : []);
 if (owners.length) await refreshRemovalSharing(em, owners, actorId);
 const users = await repo.find({ where: { ownerMemberId: memberId, endedAt: IsNull(), handedOverAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
 if (!users.length) { if (handOverTo) await dropHandOver(em, memberId, actorId); return; }
 let to = handOverTo;
 // A recipient who can't take them any more (left since, or now uses someone else's) means they close, as with no choice.
 if (to) { try { await checkHandOver(em, memberId, to); } catch (error) { if (!(error instanceof HttpException)) throw error; to = null; } }
 if (!to) { for (const row of users) await endRow(em, actorId, row, 'OWNER_LEFT'); if (handOverTo) await dropHandOver(em, memberId, actorId); return; }
 const kinds = [...new Set(users.map(row => row.kind))];
 for (const kind of kinds) {
  const ofKind = users.filter(row => row.kind === kind), mine = ofKind.find(row => row.memberId === to);
  if (mine) { mine.handedOverAt = new Date(); await repo.save(mine); }
  else await repo.save({ memberId: to, ownerMemberId: memberId, kind, value: ofKind[0].value, createdBy: actorId, handedOverAt: new Date(), endedAt: null, endedBy: null, endedHow: null });
  for (const row of ofKind.filter(item => item.memberId !== to)) {
   row.ownerMemberId = to; await repo.save(row);
   // They keep using it, now as the recipient's (section 38).
   await em.getRepository(DispatchEvent).save({ memberId: row.memberId, teamId: null, event: 'SHARED_OWNER_CHANGED', actorId, metadata: { kind, ownerId: to, previousOwnerId: memberId, why: 'handed-over' } });
  }
 }
 await em.getRepository(DispatchEvent).save({ memberId, teamId: null, event: 'ACCOUNTS_HANDED_OVER', actorId, metadata: { kinds, users: users.length, to } });
 await refreshRemovalSharing(em, [to], actorId);
}

/**
 * The person chosen at notice can't take them after all, so they close: IT's removal stops saying they're handed over (keeping
 * the lists IT reads), and a step IT completed on that understanding opens again, to record what it did (section 40).
 */
async function dropHandOver(em: EntityManager, memberId: string, actorId: string) {
 const removal = await em.getRepository(ItRemovalRequest).findOne({ where: { memberId, cancelledAt: IsNull(), completedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
 const earlier = removal?.profile.shared;
 if (!removal || !earlier?.handOverToId) return;
 const steps = handedOverSteps(removal.profile);
 removal.profile = { ...removal.profile, shared: { ...earlier, handOverToId: null, handOverTo: null } }; removal.version += 1; await em.save(removal);
 const reopened = await reopenSteps(em, removal, steps, actorId);
 if (reopened.reopened) await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId, event: 'ACCOUNTS_CORRECTED', metadata: { ...reopened, shared: true } });
}
const handedOverSteps = (profile: ItRemovalRequest['profile']) => [...(handedOver(profile, 'EMAIL') ? ['GOOGLE_WORKSPACE'] : []), ...(handedOver(profile, 'RINGCENTRAL') ? ['RINGCENTRAL'] : [])];
/** Adds the steps a removal lacks and opens again the ones IT completed, forgetting what IT recorded for them. */
async function reopenSteps(em: EntityManager, removal: ItRemovalRequest, steps: string[], actorId: string) {
 let reopened = false, added = false;
 for (const key of steps) {
  const task = await em.getRepository(ItRemovalTask).findOneBy({ requestId: removal.id, key });
  if (!task) { await em.getRepository(ItRemovalTask).save({ requestId: removal.id, key, status: 'PENDING', notes: '' }); added = true; }
  else if (task.status === 'COMPLETED') { task.status = 'PENDING'; task.updatedBy = actorId; await em.save(task); reopened = true; }
 }
 if (forgetDone(removal, steps)) await em.save(removal);
 return { reopened, added };
}
/** What IT's removal says about shared emails and numbers: what they use of others', what others use of theirs, and the hand-over chosen. */
export interface RemovalSharing { uses: { kind: SharedKind; value: string; owner: string | null; handedOver: boolean }[]; usedBy: { kind: SharedKind; value: string; users: string[] }[]; handOverToId: string | null; handOverTo: string | null }
export async function removalSharing(em: Query, memberId: string, handOverToId: string | null): Promise<RemovalSharing> {
 const { uses, usedBy } = await memberSharing(em, memberId);
 const to = handOverToId ? usedBy.flatMap(item => item.users).find(user => user.id === handOverToId) : undefined;
 return { uses: uses.map(item => ({ kind: item.kind, value: item.value, owner: item.owner?.name ?? null, handedOver: item.handedOver })),
  usedBy: usedBy.map(item => ({ kind: item.kind, value: item.value, users: item.users.map(user => user.name) })), handOverToId: to?.id ?? null, handOverTo: to?.name ?? null };
}
/**
 * A change while someone's removal is open (a new user, one who stopped) reaches what IT reads. An email or number IT wasn't
 * told about adds the Google Workspace or RingCentral step, or reopens it if IT had completed it, as refreshRemovalAccounts does.
 */
export async function refreshRemovalSharing(em: EntityManager, memberIds: string[], actorId: string) {
 for (const memberId of [...new Set(memberIds)]) {
  const removal = await em.getRepository(ItRemovalRequest).findOne({ where: { memberId, cancelledAt: IsNull(), completedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
  if (!removal) continue;
  const earlier = removal.profile.shared ?? null, shared = await removalSharing(em, memberId, earlier?.handOverToId ?? null);
  if (JSON.stringify(shared) === JSON.stringify(earlier)) continue;
  removal.profile = { ...removal.profile, shared }; removal.version += 1; await em.save(removal);
  const told = (kind: SharedKind, value: string) => [...(earlier?.uses ?? []), ...(earlier?.usedBy ?? [])].some(item => item.kind === kind && sharedKey(kind, item.value) === sharedKey(kind, value));
  const fresh = [...shared.uses, ...shared.usedBy].filter(item => !told(item.kind, item.value));
  // A hand-over that no longer applies (the person chosen stopped using it) means IT records what it did with those too.
  const kept = handedOverSteps(removal.profile), lost = earlier ? handedOverSteps({ ...removal.profile, shared: earlier }).filter(key => !kept.includes(key)) : [];
  const steps = [...new Set([...fresh.map(item => item.kind === 'EMAIL' ? 'GOOGLE_WORKSPACE' : 'RINGCENTRAL'), ...lost])];
  const { reopened, added } = await reopenSteps(em, removal, steps, actorId);
  if (reopened || added) await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId, event: 'ACCOUNTS_CORRECTED', metadata: { reopened, added, shared: true } });
 }
}
