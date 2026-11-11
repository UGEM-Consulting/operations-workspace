import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { revokeUserSessions } from '../auth/revoke';
import { SecurityEventType, StaffSecurityEvent } from '../auth/mfa.entity';
import { User, UserStatus } from '../users/user.entity';
import { onLeaveSql } from './create-member';

/**
 * A team lead's sign-in (designed in the Design System and approved by the user 2026-11-05). Choosing a lead never
 * creates an account by itself: it asks IT or an administrator, who creates it with the dispatcher's company email and
 * sends the first password themselves. Someone who stops leading but stays on is asked to be turned off, and someone who
 * leads again gets their old account back. One open request per dispatcher; done and cancelled ones stay as history.
 */
export const SIGN_IN_KINDS = ['CREATE', 'TURN_ON', 'TURN_OFF'] as const;
export type SignInKind = typeof SIGN_IN_KINDS[number];

@Entity('team_lead_sign_ins')
export class TeamLeadSignIn {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('varchar') kind!: SignInKind;
 // Who chose or cleared the lead; null when the workspace asked (the first run, or a change made elsewhere).
 @Column('uuid', { nullable: true }) createdBy!: string | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
 @Column('timestamptz', { nullable: true }) doneAt!: Date | null;
 @Column('uuid', { nullable: true }) doneBy!: string | null;
 // The account created, turned back on or turned off.
 @Column('uuid', { nullable: true }) userId!: string | null;
 @Column('timestamptz', { nullable: true }) cancelledAt!: Date | null;
}

/**
 * The company email a team lead signs in with, for the dispatcher row aliased `d` (with their recorded details as `e`):
 * what IT recorded at setup first, else what a manager recorded. The one rule for IT tasks, the team page, the Dispatchers
 * list and the sign-in itself.
 */
export const companyEmailSql = (d = 'd', e = 'e') => `coalesce((SELECT x."companyEmail" FROM (SELECT r."companyEmail", r."createdAt" FROM it_onboarding_requests r WHERE r."applicationId" = ${d}."applicationId" AND r."cancelledAt" IS NULL AND r."companyEmail" IS NOT NULL
  UNION ALL SELECT r."companyEmail", r."createdAt" FROM it_onboarding_requests r WHERE r."memberId" = ${d}.id AND r."cancelledAt" IS NULL AND r."companyEmail" IS NOT NULL) x ORDER BY x."createdAt" DESC LIMIT 1), ${e}."companyEmail")`;

/**
 * What a dispatcher's sign-in needs now, from the database. Someone leading a team (and not leaving) needs an active
 * account; someone who leads nothing doesn't keep one. Leaving turns the account off on its own, so it asks for nothing.
 */
export async function wantedSignIn(em: EntityManager, memberId: string): Promise<SignInKind | null> {
 const [row] = await em.query(`SELECT d.status, u.status AS account,
   EXISTS(SELECT 1 FROM teams t WHERE t."leadMemberId" = d.id AND t."archivedAt" IS NULL) AS leads,
   EXISTS(SELECT 1 FROM member_notices n WHERE n."memberId" = d.id AND n."cancelledAt" IS NULL AND n."finishedAt" IS NULL) AS leaving,
   ${onLeaveSql('d')} AS away
  FROM dispatch_members d LEFT JOIN users u ON u.id = d."accountUserId" WHERE d.id = $1`, [memberId]);
 if (!row || row.status === 'LEFT') return null;
 // Someone on leave (section 35) keeps leading, with their sign-in off until they're back; their return asks IT to turn it on.
 if (row.leads) return row.leaving || row.away || row.account === 'ACTIVE' ? null : row.account ? 'TURN_ON' : 'CREATE';
 return row.account === 'ACTIVE' ? 'TURN_OFF' : null;
}

/**
 * Brings each dispatcher's open request in line with what they need: a request that's no longer needed is cancelled and
 * a missing one is added. Callers have already locked the dispatcher's record, and IT locks it before the request too, so
 * IT finishing a request at the same moment waits for this change, or this waits for IT and then finds the request no
 * longer open. `ask: false` only cancels, for changes an administrator made to the account on purpose.
 */
export async function syncSignIns(em: EntityManager, memberIds: (string | null | undefined)[], actorId: string | null, ask = true) {
 for (const memberId of new Set(memberIds.filter((id): id is string => !!id))) {
  const [open]: { id: string; kind: SignInKind }[] = await em.query(`SELECT id, kind FROM team_lead_sign_ins WHERE "memberId" = $1 AND "doneAt" IS NULL AND "cancelledAt" IS NULL FOR UPDATE`, [memberId]);
  const wanted = await wantedSignIn(em, memberId);
  if (open?.kind === wanted) continue;
  if (open) await em.query(`UPDATE team_lead_sign_ins SET "cancelledAt" = now() WHERE id = $1 AND "doneAt" IS NULL AND "cancelledAt" IS NULL`, [open.id]);
  if (wanted && ask) await em.getRepository(TeamLeadSignIn).insert({ memberId, kind: wanted, createdBy: actorId });
 }
}

/** A dispatcher's company email (lowercase) and personal emails, to refuse those, and whether a manager recorded their details. */
export async function companyEmailOf(em: EntityManager, memberId: string) {
 const [row] = await em.query(`SELECT ${companyEmailSql()} AS email, e."memberId" IS NOT NULL AS "hasRecord", e."personalEmail" AS "recordedPersonal", i.email AS personal
  FROM dispatch_members d LEFT JOIN existing_member_records e ON e."memberId" = d.id LEFT JOIN dispatcher_applications a ON a.id = d."applicationId" LEFT JOIN invitations i ON i.id = a."invitationId"
  WHERE d.id = $1`, [memberId]);
 if (!row) return { email: null, personal: [] as string[], hasRecord: false };
 return { email: (row.email as string | null)?.toLowerCase() ?? null, personal: [row.personal, row.recordedPersonal].filter(Boolean).map((value: string) => value.toLowerCase()), hasRecord: !!row.hasRecord };
}

/** A sign-in account, locked, with its authVersion for revoking sessions. */
export async function lockAccount(em: EntityManager, userId: string | null) {
 return userId ? em.getRepository(User).createQueryBuilder('u').addSelect('u.authVersion').setLock('pessimistic_write').where('u.id = :id', { id: userId }).getOne() : null;
}

/** Turns a locked account off: it can't sign in and every session ends (metadata-only event: the field and why). */
export async function turnOffAccount(em: EntityManager, account: User, actorId: string, reason: string) {
 account.status = UserStatus.INACTIVE; await em.getRepository(User).update(account.id, { status: UserStatus.INACTIVE });
 await revokeUserSessions(em, account);
 await em.insert(StaffSecurityEvent, { userId: account.id, actorId, type: SecurityEventType.USER_STATUS_CHANGED, metadata: { fields: ['status'], sessionsRevoked: true, reason } });
}
