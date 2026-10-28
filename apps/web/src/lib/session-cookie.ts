// The web session cookie names, shared by server-side API calls and the BFF. Production cookies use the __Host- prefix (host-only, Secure, path /).
export type SessionKind = 'staff' | 'applicant';
export function sessionCookieName(kind: SessionKind = 'staff', env: string | undefined = process.env.NODE_ENV): string {
  const suffix = kind === 'applicant' ? 'applicant.sid' : 'operations.sid';
  return env === 'production' ? `__Host-${suffix}` : suffix;
}
/** BFF paths under applicant/ carry the applicant cookie; every other path carries the staff cookie. */
export function sessionKindForPath(path: string): SessionKind { return path.startsWith('applicant/') ? 'applicant' : 'staff'; }
