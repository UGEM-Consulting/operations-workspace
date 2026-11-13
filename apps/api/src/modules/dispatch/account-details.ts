import { EntityManager } from 'typeorm';
import { signInUsers } from '../load-boards/seats';

/** The username in what someone wrote: @name, name or a t.me link, also with the apostrophe a downloaded file puts before an @. Null when it can't be a Telegram username. */
export function telegramUsername(value: string): string | null {
 const name = value.trim().replace(/^'/, '').replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, '').replace(/^@/, '').replace(/\/$/, '');
 return /^[A-Za-z0-9_]{5,32}$/.test(name) ? name : null;
}
export const EXTENSION = /^\d{1,6}$/;

// Who uses a sign-in now comes from load board seats (section 33): open seats of people who haven't left.
export { signInsInUse, signInUsers, type SignInUser } from '../load-boards/seats';
/** Everyone else using each of someone's sign-ins. */
export async function sharedSignIns(em: Pick<EntityManager, 'query'>, memberId: string, signIns: { dat: string | null; truckstop: string | null }) {
 const users = await signInUsers(em, [signIns.dat, signIns.truckstop].filter((email): email is string => !!email));
 const others = (email: string | null) => users.filter(user => user.email === email && user.memberId !== memberId).map(({ memberId: id, name }) => ({ id, name }));
 return { dat: others(signIns.dat), truckstop: others(signIns.truckstop) };
}
