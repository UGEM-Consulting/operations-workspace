'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { CheckRenewalDialog, RenewDialog, type RenewalDriver } from './renew-document';
import type { RenewalKind, RenewalLink, RenewalScan } from './types';

/**
 * Renew or Check it on a row of Expiring documents (designed as RenewFromListScreen), opening the same dialogs as the
 * driver's page. Check it shows once the driver sent a scan; Not readable there goes on to a new link.
 */
export function ExpiringRenewal({ driver, kind, scan, link, expired, name }: { driver: RenewalDriver; kind: RenewalKind; scan: RenewalScan | null; link: RenewalLink | null; expired: boolean; name: string }) {
  const [open, setOpen] = useState<'renew' | 'link' | 'check' | null>(null);
  const waiting = scan && !scan.unreadable ? scan : null;
  return <>
    {waiting ? <Button size="sm" onClick={() => setOpen('check')}>Check it<span className="sr-only"> for {name}</span></Button>
      : <Button size="sm" variant={expired ? 'default' : 'outline'} onClick={() => setOpen('renew')}>Renew<span className="sr-only"> for {name}</span></Button>}
    {(open === 'renew' || open === 'link') && <RenewDialog driver={driver} kind={kind} expired={expired} openLink={link} initialHow={open === 'link' ? 'link' : 'upload'} onClose={() => setOpen(null)} />}
    {open === 'check' && waiting && <CheckRenewalDialog driver={driver} kind={kind} scan={waiting} onClose={() => setOpen(null)} onUnreadable={() => setOpen('link')} />}
  </>;
}
