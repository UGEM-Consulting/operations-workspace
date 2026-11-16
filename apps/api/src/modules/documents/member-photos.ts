import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Column, CreateDateColumn, DataSource, Entity, EntityManager, IsNull, PrimaryGeneratedColumn } from 'typeorm';
import { DispatchEvent, DispatchMember } from '../dispatch/dispatch.entity';
import { DispatcherApplication } from '../onboarding/entities';
import { onboardingLimit } from '../onboarding/rate-limit';
import { memberPhotoKey, photoKey, StorageService } from '../storage/storage.service';
import { Role, User, UserStatus } from '../users/user.entity';
import { cleanJpeg } from './images';
import { photoFor } from './requirements';

export type MemberPhotoKind = 'PROFILE' | 'ID';
/** A photo an administrator added for someone added by hand (section 33). The current one of each kind has no replacedAt. */
@Entity('member_photos')
export class MemberPhoto {
 @PrimaryGeneratedColumn('uuid') id!: string;
 @Column('uuid') memberId!: string;
 @Column('varchar') kind!: MemberPhotoKind;
 @Column('uuid') uploadedBy!: string;
 @Column('timestamptz', { nullable: true }) replacedAt!: Date | null;
 @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
}
const STAFF = [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER, Role.IT_SPECIALIST, Role.TEAM_LEAD, Role.SAFETY_MANAGER, Role.SAFETY_LEAD, Role.SAFETY_STAFF];

/**
 * Photos of dispatchers, supports and updaters for every staff role (section 33, the user's choice "for now", confirmed after
 * review): the profile photo and the ID photo, from their application (as of submission) or, for someone added by hand, what
 * an administrator added. A role sees them only for people it already sees: managers, administrators and IT everyone, a team
 * lead the people of their teams, Safety the dispatchers drivers have worked with. Every ID photo view is recorded. No face
 * matching. One shared check, so it can be narrowed later.
 */
@Injectable()
export class MemberPhotosService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService) {}

 /** Whether this person can see this member, by role (sees). */
 private async sees(em: Pick<EntityManager, 'query'>, user: User, memberId: string) {
  if (user.status !== UserStatus.ACTIVE || !STAFF.includes(user.role)) return false;
  if ([Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER, Role.IT_SPECIALIST].includes(user.role)) return true;
  if (user.role === Role.TEAM_LEAD) {
   // Their teams' dispatchers, and supports and updaters assisting one of them or the whole team.
   const [row] = await em.query(`WITH led AS (SELECT t.id FROM teams t JOIN dispatch_members l ON l.id = t."leadMemberId" WHERE l."accountUserId" = $1 AND l.status <> 'LEFT' AND t."archivedAt" IS NULL)
    SELECT EXISTS (SELECT 1 FROM member_assignments a WHERE a."memberId" = $2 AND a."endedAt" IS NULL AND a."teamId" IN (SELECT id FROM led))
     OR EXISTS (SELECT 1 FROM member_support_links s LEFT JOIN member_assignments a ON a."memberId" = s."dispatcherId" AND a."endedAt" IS NULL
      WHERE s."supportId" = $2 AND s."endedAt" IS NULL AND (s."teamId" IN (SELECT id FROM led) OR a."teamId" IN (SELECT id FROM led))) AS sees`, [user.id, memberId]);
   return !!row?.sees;
  }
  const [row] = await em.query(`SELECT EXISTS (SELECT 1 FROM driver_assignments WHERE "memberId" = $1) AS sees`, [memberId]);
  return !!row?.sees;
 }

 /** The photo to show: their application's (as of submission) when they have one, else what an administrator added. */
 async photo(user: User, memberId: string, kind: MemberPhotoKind) {
  if (!(await this.sees(this.db, user, memberId))) throw new NotFoundException();
  const member = await this.db.getRepository(DispatchMember).findOneBy({ id: memberId });
  if (!member) throw new NotFoundException();
  if (kind === 'ID') await onboardingLimit(this.db, 'id-photo:' + user.id, 60, 900);
  let body: Buffer | null = null;
  const application = member.applicationId ? await this.db.getRepository(DispatcherApplication).findOneBy({ id: member.applicationId, status: 'APPROVED' }) : null;
  if (application) {
   const photo = await photoFor(this.db.manager, application.id, kind === 'PROFILE' ? 'SELFIE' : 'ID_SELFIE', application.submittedAt);
   if (photo) body = await this.storage.get(photoKey(photo));
  }
  if (!body) {
   const photo = await this.db.getRepository(MemberPhoto).findOneBy({ memberId, kind, replacedAt: IsNull() });
   if (photo) body = await this.storage.get(memberPhotoKey(photo));
  }
  if (!body) throw new NotFoundException();
  // Who opened an ID photo, and when: on their page for managers, never what it shows.
  if (kind === 'ID') await this.db.getRepository(DispatchEvent).save({ memberId, teamId: null, event: 'ID_PHOTO_VIEWED', actorId: user.id, metadata: { role: user.role } });
  return { body, type: 'image/jpeg' as const, filename: kind === 'PROFILE' ? 'profile-photo.jpg' : 'id-photo.jpg' };
 }

 /**
  * An administrator adds a photo for someone added by hand (HandPhotoUploadScreen): one JPEG, cleaned (metadata, comments and
  * trailing bytes dropped). It replaces the shown one; the earlier file is kept. Someone with an application keeps theirs.
  */
 async add(user: User, memberId: string, kind: MemberPhotoKind, image: string) {
  if (user.role !== Role.SYSTEM_ADMIN || user.status !== UserStatus.ACTIVE) throw new ForbiddenException();
  if (!this.storage.enabled) throw new ServiceUnavailableException('Photo storage is not configured.');
  await onboardingLimit(this.db, 'member-photo:' + user.id, 30, 3600);
  const first = await this.check(this.db.manager, memberId);
  let body: Buffer;
  try { body = cleanJpeg(Buffer.from(image, 'base64')); } catch { throw new BadRequestException('Upload a JPEG photo.'); }
  const id = randomUUID(), key = memberPhotoKey({ id, kind, memberId: first.id });
  await this.storage.put(key, body, 'image/jpeg');
  try {
   return await this.db.transaction(async em => {
    const member = await em.getRepository(DispatchMember).findOne({ where: { id: memberId }, lock: { mode: 'pessimistic_write' } });
    await this.check(em, memberId);
    const current = await em.getRepository(MemberPhoto).findOne({ where: { memberId, kind, replacedAt: IsNull() }, lock: { mode: 'pessimistic_write' } });
    if (current) { current.replacedAt = new Date(); await em.save(current); }
    await em.getRepository(MemberPhoto).save({ id, memberId, kind, uploadedBy: user.id });
    member!.version += 1; await em.save(member!);
    await em.getRepository(DispatchEvent).save({ memberId, teamId: null, event: 'PHOTO_ADDED', actorId: user.id, metadata: { kind, replaced: !!current } });
    return { id, version: member!.version };
   });
  } catch (error) { await this.storage.remove(key); throw error; }
 }
 private async check(em: EntityManager, memberId: string) {
  const member = await em.getRepository(DispatchMember).findOneBy({ id: memberId });
  if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
  if (member.applicationId) throw new ConflictException('Their photos come from their application.');
  if (!(await em.query(`SELECT 1 FROM existing_member_records WHERE "memberId" = $1`, [memberId])).length) throw new ConflictException('Photos are added here only for someone added by hand.');
  return member;
 }
}
/** For their page: the photos an administrator added (who and when), and the latest ID photo views. */
export async function photoSummary(em: Pick<EntityManager, 'query'>, memberId: string) {
  const photos: { kind: MemberPhotoKind; createdAt: Date; uploadedBy: string | null }[] = await em.query(`SELECT p.kind, p."createdAt", u."firstName" || ' ' || u."lastName" AS "uploadedBy"
   FROM member_photos p LEFT JOIN users u ON u.id = p."uploadedBy" WHERE p."memberId" = $1 AND p."replacedAt" IS NULL`, [memberId]);
  const views = await em.query(`SELECT e."createdAt", u."firstName" || ' ' || u."lastName" AS "viewedBy", e.metadata->>'role' AS role FROM dispatch_events e LEFT JOIN users u ON u.id = e."actorId"
   WHERE e."memberId" = $1 AND e.event = 'ID_PHOTO_VIEWED' ORDER BY e."createdAt" DESC LIMIT 10`, [memberId]);
  return { profile: photos.find(photo => photo.kind === 'PROFILE') ?? null, id: photos.find(photo => photo.kind === 'ID') ?? null, idViews: views };
}
/** Which of someone's photos exist: their application's (as of submission), else what an administrator added. */
export async function photoPresence(em: Pick<EntityManager, 'query'>, memberId: string): Promise<{ profile: boolean; id: boolean }> {
 const [row] = await em.query(`SELECT
   EXISTS (SELECT 1 FROM dispatch_members d JOIN dispatcher_applications a ON a.id = d."applicationId" AND a.status = 'APPROVED' JOIN applicant_photos p ON p."applicationId" = a.id AND p.kind = 'SELFIE' AND p."createdAt" <= a."submittedAt" WHERE d.id = $1)
    OR EXISTS (SELECT 1 FROM member_photos p WHERE p."memberId" = $1 AND p.kind = 'PROFILE' AND p."replacedAt" IS NULL) AS profile,
   EXISTS (SELECT 1 FROM dispatch_members d JOIN dispatcher_applications a ON a.id = d."applicationId" AND a.status = 'APPROVED' JOIN applicant_photos p ON p."applicationId" = a.id AND p.kind = 'ID_SELFIE' AND p."createdAt" <= a."submittedAt" WHERE d.id = $1)
    OR EXISTS (SELECT 1 FROM member_photos p WHERE p."memberId" = $1 AND p.kind = 'ID' AND p."replacedAt" IS NULL) AS id`, [memberId]);
 return { profile: !!row?.profile, id: !!row?.id };
}
