import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readBackendConfig } from './backend-connection';
export interface StaffUser { id: string; firstName: string; lastName: string; email: string; role: string; status: string; mfaEnabled?: boolean; }
export interface Identity { user: StaffUser; navigation: { key: string; href: string; label: string }[]; landingPage: string; }
export function backendConfig() {
  return readBackendConfig(process.env);
}
export async function apiRequest(path: string) {
  const { base, key } = backendConfig();
  const jar = await cookies();
  const name = process.env.NODE_ENV === 'production' ? '__Host-operations.sid' : 'operations.sid';
  const session = jar.get(name);
  try {
    return await fetch(`${base}/api/${path}`, { headers: { 'x-workspace-key': key, cookie: session ? `${name}=${session.value}` : '' }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
  } catch {
    throw new Error('The authentication service is unavailable. Please try again.');
  }
}
export const getIdentity = cache(async (): Promise<Identity | null> => {
  const jar = await cookies();
  const name = process.env.NODE_ENV === 'production' ? '__Host-operations.sid' : 'operations.sid';
  // No cookie means there is no session to verify. Never treat an API outage as a valid session.
  if (!jar.get(name)?.value) return null;
  const response = await apiRequest('auth/me');
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('The authentication service is unavailable. Please try again.');
  return response.json() as Promise<Identity>;
});
export async function requireIdentity() {
  const identity = await getIdentity();
  if (!identity) redirect('/login');
  return identity;
}
export async function requirePage(key: string) {
  const identity = await requireIdentity();
  const response = await apiRequest(`access/${encodeURIComponent(key)}`);
  if (response.status === 401) redirect('/login');
  if (response.status === 403) redirect('/access-denied');
  if (!response.ok) throw new Error('The authorization service is unavailable. Please try again.');
  return identity;
}
