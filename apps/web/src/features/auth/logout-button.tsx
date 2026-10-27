"use client";
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { mutate } from '@/lib/client-api';
export function LogoutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return <div><Button variant="outline" disabled={pending} onClick={async () => {
    setPending(true); setError('');
    // A full navigation discards the authenticated client router cache.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    try { await mutate('auth/logout', 'POST'); window.location.assign('/login'); }
    catch { setError('Sign out failed. Try again.'); setPending(false); }
  }}>{pending ? 'Signing out…' : 'Sign out'}</Button>{error && <p role="alert" className="text-xs text-danger">{error}</p>}</div>;
}
