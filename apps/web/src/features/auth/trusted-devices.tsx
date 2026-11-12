"use client";
import { useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardFooter, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { LocalTime } from '@/components/ui/local-time';
import { Table } from '@/components/ui/table';
import { ApiError, errorMessage, mutate, readApi } from '@/lib/client-api';
import { DEVICES_CHANGED_EVENT } from './devices-changed';

interface Device { id: string; label: string; createdAt: string; lastUsedAt: string; expiresAt: string; current: boolean }
interface Devices { available: boolean; administrator: boolean; days: number; items: Device[] }
const TITLE = 'Devices that skip the code';

/**
 * Account security's trusted devices (TrustedDevicesScreen and its empty, administrator and phone versions). Loaded in the
 * browser, because the BFF forwards the device cookie that marks “This device” only on these routes, and again after a
 * password change on this page (DEVICES_CHANGED_EVENT). An older API answers 404 and the card stays out.
 */
export function TrustedDevices() {
  const [data, setData] = useState<Devices | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  // State changes only once the request answers, never during the effect itself.
  const load = () => readApi<Devices>('auth/mfa/devices').then(result => { setData(result); setError(''); },
    failure => { if (!(failure instanceof ApiError && failure.status === 404)) setError(errorMessage(failure, 'Your devices could not be loaded.')); });
  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener(DEVICES_CHANGED_EVENT, reload);
    return () => window.removeEventListener(DEVICES_CHANGED_EVENT, reload);
  }, []);
  async function forget(id: string | null) {
    setBusy(id ?? 'all'); setError('');
    try { await mutate(id ? `auth/mfa/devices/${id}/forget` : 'auth/mfa/devices/forget-all', 'POST'); setConfirmAll(false); await load(); }
    // Already gone (forgotten elsewhere, or by a password change): show the list as it is now.
    catch (failure) { if (failure instanceof ApiError && failure.status === 404) { setConfirmAll(false); await load(); } else setError(errorMessage(failure, 'The device could not be forgotten.')); }
    finally { setBusy(null); }
  }
  if (error && !data) return <Card><CardHeader className="pb-4" title={TITLE} description={<span className="text-danger">{error}</span>} /></Card>;
  if (!data) return null;
  if (data.administrator) return <Card><CardHeader className="pb-4" title={TITLE} description="Not for administrators: you enter a code at every sign-in, because your account can change everyone else’s." /></Card>;
  if (!data.available) return null;
  if (!data.items.length) return <Card><CardHeader className="pb-4" title={TITLE} description="None. To skip the code on your own computer or phone, tick “Don’t ask for a code” when you sign in there." /></Card>;
  return <Card>
    <CardHeader title={TITLE} description={`You ticked “Don’t ask for a code” when signing in on these. Each one asks again after ${data.days} days.`} />
    <Table className="mt-3 border-t border-border" caption={TITLE} rows={data.items} rowKey={row => row.id} columns={[
      { key: 'device', label: 'Device', primary: true, cell: row => <div><div className="font-medium">{row.label}</div><div className="text-[13px] leading-5 text-muted-foreground">{row.current ? 'This device · since ' : 'Since '}<LocalTime iso={row.createdAt} format="date" /></div></div> },
      { key: 'used', label: 'Last used', hideBelow: 'md', cell: row => row.current ? 'Now' : <LocalTime iso={row.lastUsedAt} format="date" /> },
      { key: 'expires', label: 'Asks again', cell: row => <LocalTime iso={row.expiresAt} format="date" /> },
      { key: 'actions', label: 'Actions', srOnly: true, align: 'right', action: true, cell: row => <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void forget(row.id)}>{busy === row.id ? 'Forgetting…' : row.current ? 'Forget this device' : 'Forget'}</Button> }]} />
    {error && <p role="alert" className="px-4 pb-2 text-sm text-danger sm:px-5">{error}</p>}
    <CardFooter><p className="text-[13px] leading-5 text-muted-foreground">Changing your password or authenticator forgets them all.</p>
      <Button variant="outline" disabled={busy !== null} onClick={() => setConfirmAll(true)}><LogOut aria-hidden="true" className="size-4" />Forget all devices</Button></CardFooter>
    {confirmAll && <Dialog open onClose={() => setConfirmAll(false)} size="sm" tone="warning" busy={busy === 'all'} title="Forget all devices?"
      actions={<Button disabled={busy !== null} onClick={() => void forget(null)}>{busy === 'all' ? 'Forgetting…' : 'Forget all devices'}</Button>}>
      <p className="text-sm text-muted-foreground">Every device, this one included, asks for a code at the next sign-in. You stay signed in where you are now.</p></Dialog>}
  </Card>;
}
