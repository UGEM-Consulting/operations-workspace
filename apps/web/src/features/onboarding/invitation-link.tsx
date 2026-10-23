'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { ApplicantAccess } from './applicant-access';
// Invitation links are /apply#<token>. Browsers never send the fragment to servers, so the
// credential stays out of hosting, CDN and APM request logs and out of Referer headers.
let captured = '';
function readFragment() {
  const hash = window.location.hash;
  if (hash) captured = hash.slice(1);
  return captured;
}
const subscribe = () => () => {};
export function InvitationLink() {
  const token = useSyncExternalStore(subscribe, readFragment, () => null);
  // Remove the token from the address bar and history once it is held in memory.
  useEffect(() => { if (window.location.hash) window.history.replaceState(null, '', window.location.pathname); }, []);
  if (token === null) return <p role="status" className="text-sm text-muted-foreground">Opening your invitation…</p>;
  if (!/^[a-f0-9]{64}$/.test(token)) return <p>This invitation link is incomplete or invalid. Open the full link from your manager, or ask for a new one.</p>;
  return <ApplicantAccess token={token}/>;
}
