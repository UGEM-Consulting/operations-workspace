import { NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { SecurityEventType, StaffSecurityEvent } from '../auth/mfa.entity';
import { onboardingLimit } from '../onboarding/rate-limit';
import type { User } from '../users/user.entity';
import type { SaveSignatureDto } from './documents.dto';
import { StaffSavedSignature } from './documents.entity';
import { assertSignatureEmbeds, decodeSignature } from './images';
/**
 * A manager's or administrator's saved countersigning signature. Only its owner reads it; every countersignature still
 * needs the signer's explicit statement for that document, and copies the image into that document's own record.
 */
export async function savedSignature(db: DataSource, user: User) {
 const saved = await db.getRepository(StaffSavedSignature).createQueryBuilder('s').addSelect('s.signatureImage').where('s.userId = :id', { id: user.id }).getOne();
 return { saved: saved ? { typedName: saved.typedName, signatureMethod: saved.signatureMethod, updatedAt: saved.updatedAt,
  image: `data:image/png;base64,${saved.signatureImage.toString('base64')}` } : null };
}
export async function saveSignature(db: DataSource, user: User, input: SaveSignatureDto) {
 await onboardingLimit(db, 'saved-signature:' + user.id, 20, 3600);
 const image = decodeSignature(input.signature);
 await assertSignatureEmbeds(image);
 await db.transaction(async manager => {
  const replaced = await manager.getRepository(StaffSavedSignature).existsBy({ userId: user.id });
  await manager.query(`INSERT INTO staff_saved_signatures ("userId","typedName","signatureImage","signatureMethod") VALUES ($1,$2,$3,$4)
   ON CONFLICT ("userId") DO UPDATE SET "typedName"=EXCLUDED."typedName","signatureImage"=EXCLUDED."signatureImage","signatureMethod"=EXCLUDED."signatureMethod","updatedAt"=now()`,
   [user.id, input.typedName, image, input.signatureMethod]);
  await manager.insert(StaffSecurityEvent, { userId: user.id, actorId: user.id, type: SecurityEventType.STAFF_SIGNATURE_SAVED, metadata: { replaced, method: input.signatureMethod } });
 });
 return savedSignature(db, user);
}
export async function deleteSignature(db: DataSource, user: User) {
 await db.transaction(async manager => {
  const { affected } = await manager.getRepository(StaffSavedSignature).delete({ userId: user.id });
  if (!affected) throw new NotFoundException('No saved signature');
  await manager.insert(StaffSecurityEvent, { userId: user.id, actorId: user.id, type: SecurityEventType.STAFF_SIGNATURE_DELETED, metadata: {} });
 });
 return { saved: null };
}
/** Account changes that end the user's sessions (email, role, status, password set by an administrator, MFA reset) also discard the saved signature. */
export async function clearSavedSignature(manager: EntityManager, userId: string, actorId: string, reason: string): Promise<boolean> {
 const { affected } = await manager.getRepository(StaffSavedSignature).delete({ userId });
 if (affected) await manager.insert(StaffSecurityEvent, { userId, actorId, type: SecurityEventType.STAFF_SIGNATURE_CLEARED, metadata: { reason } });
 return !!affected;
}
