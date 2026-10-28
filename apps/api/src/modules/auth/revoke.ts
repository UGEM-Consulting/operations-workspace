import type { EntityManager } from 'typeorm';
import { User } from '../users/user.entity';
/**
 * Ends every session of the user inside the caller's transaction: full sessions and half-signed-in ones (pending
 * password change or second step). Incrementing authVersion also stops an in-flight sign-in from restoring access.
 * Callers that keep the acting user signed in re-establish only that session afterwards.
 */
export async function revokeUserSessions(manager: EntityManager, user: Pick<User, 'id' | 'authVersion'>): Promise<void> {
  user.authVersion += 1;
  await manager.getRepository(User).update(user.id, { authVersion: user.authVersion });
  await manager.query(`DELETE FROM staff_sessions WHERE sess->>'userId' = $1 OR sess->'mfaPending'->>'userId' = $1`, [user.id]);
}
