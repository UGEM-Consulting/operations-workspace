"use client";
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { mutate } from '@/lib/client-api';
/** Signs out, then a full navigation discards the authenticated client router cache. */
export function useSignOut() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function signOut() {
    setPending(true); setError('');
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    try { await mutate('auth/logout', 'POST'); window.location.assign('/login'); }
    catch { setError('Sign out failed. Try again.'); setPending(false); }
  }
  return { signOut, pending, error };
}
export function LogoutButton() {
  const { signOut, pending, error } = useSignOut();
  return <div><Button variant="outline" disabled={pending} onClick={() => void signOut()}>{pending ? 'Signing out…' : 'Sign out'}</Button>{error && <p role="alert" className="text-xs text-danger">{error}</p>}</div>;
}
