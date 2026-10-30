// The web session cookie names, shared by server-side API calls and the BFF. Production cookies use the __Host- prefix (host-only, Secure, path /).
export type SessionKind = 'staff' | 'applicant' | 'driver';
export function sessionCookieName(kind: SessionKind = 'staff', env: string | undefined = process.env.NODE_ENV): string {
  const suffix = kind === 'applicant' ? 'applicant.sid' : kind === 'driver' ? 'driver.sid' : 'operations.sid';
  return env === 'production' ? `__Host-${suffix}` : suffix;
}
/** BFF paths under applicant/ and driver/ carry their own cookies; every other path carries the staff cookie. */
export function sessionKindForPath(path: string): SessionKind { return path.startsWith('applicant/') ? 'applicant' : path.startsWith('driver/') ? 'driver' : 'staff'; }
