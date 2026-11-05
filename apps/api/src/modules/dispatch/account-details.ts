import { EntityManager } from 'typeorm';

/** The username in what someone wrote: @name, name or a t.me link, also with the apostrophe a downloaded file puts before an @. Null when it can't be a Telegram username. */
export function telegramUsername(value: string): string | null {
 const name = value.trim().replace(/^'/, '').replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, '').replace(/^@/, '').replace(/\/$/, '');
 return /^[A-Za-z0-9_]{5,32}$/.test(name) ? name : null;
}
export const EXTENSION = /^\d{1,6}$/;

// What managers recorded and what IT set up, for people who haven't left. The one rule for who counts as using a sign-in.
const SIGN_IN_USERS = `(
   SELECT "memberId", "datEmail" AS email FROM existing_member_records WHERE "datEmail" IS NOT NULL
   UNION ALL SELECT "memberId", "truckstopEmail" FROM existing_member_records WHERE "truckstopEmail" IS NOT NULL
   UNION ALL SELECT m.id, r."datEmail" FROM it_onboarding_requests r JOIN dispatch_members m ON m."applicationId" = r."applicationId" WHERE r."datEmail" IS NOT NULL AND r."cancelledAt" IS NULL
   UNION ALL SELECT m.id, r."truckstopEmail" FROM it_onboarding_requests r JOIN dispatch_members m ON m."applicationId" = r."applicationId" WHERE r."truckstopEmail" IS NOT NULL AND r."cancelledAt" IS NULL
  ) v JOIN dispatch_members d ON d.id = v."memberId" WHERE d.status <> 'LEFT'`;
/** Every load board sign-in someone here uses, for checking a file against. */
export async function signInsInUse(em: Pick<EntityManager, 'query'>): Promise<Set<string>> {
 const rows: { email: string }[] = await em.query(`SELECT DISTINCT v.email FROM ${SIGN_IN_USERS}`);
 return new Set(rows.map(row => row.email));
}
export interface SignInUser { email: string; memberId: string; name: string }
/** Who still uses these load board sign-ins. Sign-ins may be shared, so this is how anyone closing one knows who else needs it. */
export function signInUsers(em: Pick<EntityManager, 'query'>, emails: string[]): Promise<SignInUser[]> {
 if (!emails.length) return Promise.resolve([]);
 return em.query(`SELECT DISTINCT v.email, d.id AS "memberId", d."firstName" || ' ' || d."lastName" AS name FROM ${SIGN_IN_USERS} AND v.email = ANY($1)`, [emails]);
}
/** Everyone else using each of someone's sign-ins. */
export async function sharedSignIns(em: Pick<EntityManager, 'query'>, memberId: string, signIns: { dat: string | null; truckstop: string | null }) {
 const users = await signInUsers(em, [signIns.dat, signIns.truckstop].filter((email): email is string => !!email));
 const others = (email: string | null) => users.filter(user => user.email === email && user.memberId !== memberId).map(({ memberId: id, name }) => ({ id, name }));
 return { dat: others(signIns.dat), truckstop: others(signIns.truckstop) };
}
