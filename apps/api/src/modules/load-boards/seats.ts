import { EntityManager, IsNull } from 'typeorm';
import { ItRemovalActivity, ItRemovalRequest, ItRemovalTask, type RemovalSeat } from '../it/it.entity';
import { LoadBoardSeat, Provider } from './load-boards.entity';

type Query = Pick<EntityManager, 'query'>;
/** A seat as people read it: the account, the sign-in, and who else uses the same sign-in. */
export interface SeatView {
 id: string; accountId: string; account: string; provider: Provider; placeholder: boolean; signInEmail: string; status: 'ACTIVE' | 'SUSPENDED' | 'ENDED';
 startedAt: string; suspendedAt: string | null; endedAt: string | null; endedHow: string | null; version: number; sharedWith: { id: string; name: string }[];
}
// Open seats of people who haven't left: the one rule for who uses a sign-in.
const IN_USE = `member_load_board_seats s JOIN dispatch_members d ON d.id = s."memberId" WHERE s.status <> 'ENDED' AND d.status <> 'LEFT'`;
/** Every load board sign-in someone here uses, for checking a file against. */
export async function signInsInUse(em: Query): Promise<Set<string>> {
 const rows: { email: string }[] = await em.query(`SELECT DISTINCT s."signInEmail" AS email FROM ${IN_USE}`);
 return new Set(rows.map(row => row.email));
}
export interface SignInUser { email: string; memberId: string; name: string }
/** Who still uses these sign-ins. Sign-ins may be shared, so this is how anyone closing one knows who else needs it. */
export function signInUsers(em: Query, emails: string[]): Promise<SignInUser[]> {
 if (!emails.length) return Promise.resolve([]);
 return em.query(`SELECT DISTINCT s."signInEmail" AS email, d.id AS "memberId", d."firstName" || ' ' || d."lastName" AS name FROM ${IN_USE} AND s."signInEmail" = ANY($1)`, [emails]);
}
/** Someone's seats, newest first (open ones only unless all), each with the others using the same sign-in. */
export async function memberSeats(em: Query, memberId: string, all = false): Promise<SeatView[]> {
 const rows: Omit<SeatView, 'sharedWith'>[] = await em.query(`SELECT s.id, s."accountId", a.name AS account, a.provider, a.placeholder, s."signInEmail", s.status, s."startedAt", s."suspendedAt", s."endedAt", s."endedHow", s.version
  FROM member_load_board_seats s JOIN load_board_accounts a ON a.id = s."accountId" WHERE s."memberId" = $1 ${all ? '' : `AND s.status <> 'ENDED'`}
  ORDER BY (s.status = 'ENDED'), s."startedAt" DESC, s."createdAt" DESC`, [memberId]);
 const users = await signInUsers(em, [...new Set(rows.filter(row => row.status !== 'ENDED').map(row => row.signInEmail))]);
 return rows.map(row => ({ ...row, sharedWith: row.status === 'ENDED' ? [] : users.filter(user => user.email === row.signInEmail && user.memberId !== memberId).map(({ memberId: id, name }) => ({ id, name })) }));
}

/**
 * Keeps the seats in step with the sign-ins recorded the older way (a manager's record, or IT's setup, newest first): a
 * recorded sign-in nobody holds a seat for becomes a seat on "<provider> account not recorded", and a changed one moves that
 * seat's email. Seats on real accounts are never touched. Called wherever those sign-ins are written; writes no events.
 */
export async function syncRecordedSeats(em: EntityManager, memberId: string, actorId: string | null) {
 const [member] = await em.query(`SELECT d.status, d."leftAt", (SELECT row_to_json(x) FROM (SELECT
   coalesce((SELECT r."datEmail" FROM it_onboarding_requests r WHERE r."datEmail" IS NOT NULL AND r."cancelledAt" IS NULL AND (r."memberId" = d.id OR r."applicationId" = d."applicationId") ORDER BY r."createdAt" DESC LIMIT 1), e."datEmail") AS "DAT",
   coalesce((SELECT r."truckstopEmail" FROM it_onboarding_requests r WHERE r."truckstopEmail" IS NOT NULL AND r."cancelledAt" IS NULL AND (r."memberId" = d.id OR r."applicationId" = d."applicationId") ORDER BY r."createdAt" DESC LIMIT 1), e."truckstopEmail") AS "TRUCKSTOP") x) AS recorded
  FROM dispatch_members d LEFT JOIN existing_member_records e ON e."memberId" = d.id WHERE d.id = $1`, [memberId]);
 if (!member) return;
 const repo = em.getRepository(LoadBoardSeat);
 for (const provider of ['DAT', 'TRUCKSTOP'] as Provider[]) {
  const email = (member.recorded?.[provider] as string | null)?.toLowerCase() ?? null;
  const seats: (LoadBoardSeat & { placeholder: boolean })[] = await em.query(`SELECT s.*, a.placeholder FROM member_load_board_seats s JOIN load_board_accounts a ON a.id = s."accountId" WHERE s."memberId" = $1 AND a.provider = $2`, [memberId, provider]);
  const placeholder = seats.find(seat => seat.placeholder && seat.status !== 'ENDED');
  if (!email) {
   // Cleared: the seat that only held it ends; a seat on a real account stays.
   if (placeholder) await repo.update(placeholder.id, { status: 'ENDED', endedAt: new Date(), endedHow: 'ENDED', endedBy: actorId, suspendedAt: null, version: placeholder.version + 1 });
   continue;
  }
  if (seats.some(seat => seat.signInEmail === email && (seat.status !== 'ENDED' || member.status === 'LEFT'))) continue;
  if (placeholder) { await repo.update(placeholder.id, { signInEmail: email, version: placeholder.version + 1 }); continue; }
  const account = await placeholderAccount(em, provider);
  const left = member.status === 'LEFT';
  await repo.save({ memberId, accountId: account.id, signInEmail: email, status: left ? 'ENDED' : 'ACTIVE', startedAt: new Date(), createdBy: actorId,
   endedAt: left ? (member.leftAt ?? new Date()) : null, endedHow: left ? 'LEFT' : null, endedBy: left ? actorId : null });
 }
}

/** "<provider> account not recorded", made again if it's missing (the migration adds both). */
export async function placeholderAccount(em: Query, provider: Provider): Promise<{ id: string }> {
 await em.query(`INSERT INTO load_board_accounts (provider, name, "nameKey", placeholder) VALUES ($1, $2::varchar, lower($2::varchar), true) ON CONFLICT DO NOTHING`, [provider, `${provider === 'DAT' ? 'DAT' : 'Truckstop'} account not recorded`]);
 const [account] = await em.query(`SELECT id FROM load_board_accounts WHERE provider = $1 AND placeholder`, [provider]);
 return account;
}
/**
 * An open removal lists the seats IT must end (or change the password of, when shared). A seat change while it's open
 * updates that list and reopens Load boards (business software) if IT had already completed it.
 */
export async function refreshRemovalSeats(em: EntityManager, memberId: string, actorId: string) {
 const removal = await em.getRepository(ItRemovalRequest).findOne({ where: { memberId, cancelledAt: IsNull(), completedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
 if (!removal) return;
 const seats = await removalSeats(em, memberId);
 const profile = removal.profile, earlier = profile.seats ?? [];
 if (JSON.stringify(earlier) === JSON.stringify(seats)) return;
 removal.profile = { ...profile, seats };
 removal.version += 1; await em.save(removal);
 // Only a sign-in IT hasn't been told about reopens the step: one already listed, or recorded the older way, doesn't.
 const known = (seat: RemovalSeat) => earlier.some(item => item.account === seat.account && item.signInEmail === seat.signInEmail) || [profile.datEmail, profile.truckstopEmail].includes(seat.signInEmail);
 if (!seats.some(seat => !known(seat))) return;
 const task = await em.getRepository(ItRemovalTask).findOneBy({ requestId: removal.id, key: 'BUSINESS_SOFTWARE' });
 const added = !task, reopened = task?.status === 'COMPLETED';
 if (!task) await em.getRepository(ItRemovalTask).save({ requestId: removal.id, key: 'BUSINESS_SOFTWARE', status: 'PENDING', notes: '' });
 else if (reopened) { task.status = 'PENDING'; task.updatedBy = actorId; await em.save(task); }
 await em.getRepository(ItRemovalActivity).save({ requestId: removal.id, actorId, event: 'ACCOUNTS_CORRECTED', metadata: { reopened, added, seats: true } });
}
/**
 * The seats a removal lists: open ones, and for someone already recorded as Left, the seats that ended with their leaving
 * (their access may still be open, which is why IT is asked). IT's own removal ends the open ones.
 */
export async function removalSeats(em: Query, memberId: string) {
 return (await memberSeats(em, memberId, true)).filter(seat => seat.status !== 'ENDED' || seat.endedHow === 'LEFT').map(removalSeat);
}
/** What a removal keeps of a seat: no ids beyond the seat's, and who else shares the sign-in when it was taken. */
export const removalSeat = (seat: SeatView) => ({ id: seat.id, account: seat.account, provider: seat.provider, signInEmail: seat.signInEmail, status: seat.status, sharedWith: seat.sharedWith.map(user => user.name) }) satisfies RemovalSeat;
/** IT finished someone's removal: their open seats end on that day, as having left. */
export async function endSeatsOnLeaving(em: EntityManager, memberId: string, actorId: string) {
 await em.query(`UPDATE member_load_board_seats SET status = 'ENDED', "endedAt" = now(), "endedHow" = 'LEFT', "endedBy" = $2, "suspendedAt" = NULL, version = version + 1, "updatedAt" = now()
  WHERE "memberId" = $1 AND status <> 'ENDED'`, [memberId, actorId]);
}
