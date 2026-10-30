'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Link2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { OneTimeLinkDialog } from './one-time-link-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { DescriptionList } from '@/components/ui/description-list';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { licenseTypes, type DriverProfile, type LicenseType } from './types';

// A revealed SSN stays on the page only briefly: it is cleared after a minute, when the tab is hidden and on leaving.
const SSN_VISIBLE_MS = 60_000;
const date = (value: string | undefined) => value ? <LocalTime iso={`${value}T12:00:00Z`} format="date" /> : null;

/**
 * The driver's own application: the link Safety sends (bound to the email on the record, shown once when sent) and the
 * answers they gave. The SSN shows as its last four digits; the full number is fetched only on request and every view
 * is recorded. `screener` sends and cancels links; screeners and the driver's owner may view the full SSN.
 */
export function ApplicationCard({ driver, screener, owns }: { driver: DriverProfile; screener: boolean; owns: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [sent, setSent] = useState<{ url: string; expiresAt: string } | null>(null);
  const [ssn, setSsn] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<'cancel' | 'send' | null>(null);
  const hideSsn = useCallback(() => setSsn(''), []);
  useEffect(() => {
    if (!ssn) return;
    const timer = window.setTimeout(hideSsn, SSN_VISIBLE_MS);
    const hidden = () => { if (document.visibilityState === 'hidden') hideSsn(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', hidden); };
  }, [ssn, hideSsn]);
  const { link, application } = driver, fields = application?.fields ?? {};
  const canLink = screener && ['LEAD', 'APPLYING'].includes(driver.status);
  async function sendLink() {
    if (pending) return;
    setPending('send'); setError('');
    try {
      const result = await mutate<{ url: string; expiresAt: string }>(`safety/drivers/${driver.id}/link`, 'POST', { version: driver.version });
      setConfirming(null); setSent(result); router.refresh();
    } catch (error) { setError(errorMessage(error, 'The link wasn’t created. Try again.')); }
    finally { setPending(null); }
  }
  async function cancelLink() {
    if (pending) return;
    setPending('cancel'); setError('');
    try { await mutate(`safety/drivers/${driver.id}/link/cancel`, 'POST', { version: driver.version }); setConfirming(null); toast({ title: 'Link cancelled', description: 'It no longer opens the application.' }); router.refresh(); }
    catch (error) { setError(errorMessage(error, 'The link wasn’t cancelled. Reload and try again.')); }
    finally { setPending(null); }
  }
  async function reveal() {
    if (pending) return;
    setPending('ssn'); setError('');
    try { setSsn((await mutate<{ ssn: string }>(`safety/drivers/${driver.id}/ssn`, 'POST', {})).ssn); router.refresh(); }
    catch (error) { setError(errorMessage(error, 'The number couldn’t be shown.')); }
    finally { setPending(null); }
  }
  const address = [fields.addressLine1, fields.addressLine2, [fields.city, [fields.state, fields.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean);
  return <Card>
    <CardHeader title="Application" description={application?.status === 'SUBMITTED' ? <>Sent by the driver <LocalTime iso={application.submittedAt!} format="date" />.</>
      : link ? 'The driver fills this in through their link.' : 'Send the driver a link to fill in their application.'}
      actions={application && <Badge label={application.status === 'SUBMITTED' ? 'Submitted' : 'In progress'} tone={application.status === 'SUBMITTED' ? 'success' : 'info'} />} />
    <CardBody className="space-y-5">
      {canLink && <div className="rounded-md border border-border p-4">
        {link ? <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 text-sm"><p className="flex items-center gap-2 font-medium"><Link2 aria-hidden="true" className="size-4 text-muted-foreground" />Link sent to {link.email}</p>
            <p className="text-[13px] text-muted-foreground">{link.expired ? 'Expired' : <>Works until <LocalTime iso={link.expiresAt} format="date" /></>} · {link.openedAt ? <>opened <LocalTime iso={link.openedAt} format="date" /></> : 'not opened yet'}</p></div>
          <span className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" className="text-danger" disabled={!!pending} onClick={() => { setError(''); setConfirming('cancel'); }}>Cancel link</Button>
            <Button size="sm" variant="outline" disabled={!!pending} onClick={() => { setError(''); setConfirming('send'); }}>Send a new link</Button></span>
        </div> : <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-muted-foreground">{driver.email ? <>The link works only with <span className="font-medium text-foreground">{driver.email}</span>.</> : 'Add the driver’s email in Edit details first; the link works only with that address.'}</p>
          <Button size="sm" disabled={!driver.email || !!pending} onClick={() => void sendLink()}><Send aria-hidden="true" className="size-4" />{pending === 'send' ? 'Creating…' : 'Create application link'}</Button>
        </div>}
      </div>}
      {application && <DescriptionList items={[
        { label: 'Legal name', value: [fields.legalFirstName, fields.legalMiddleName, fields.legalLastName].filter(Boolean).join(' ') || null },
        { label: 'Date of birth', value: date(fields.dateOfBirth) },
        { label: 'Social Security number', value: application.ssnLast4 ? <span className="flex flex-wrap items-center gap-2"><span className="font-mono">{ssn || `•••-••-${application.ssnLast4}`}</span>
          {ssn ? <Button size="sm" variant="ghost" onClick={hideSsn}><EyeOff aria-hidden="true" className="size-4" />Hide<span className="sr-only"> the full number</span></Button>
            : (screener || owns) && <Button size="sm" variant="ghost" disabled={!!pending} aria-describedby="ssn-recorded" onClick={() => void reveal()}><Eye aria-hidden="true" className="size-4" />{pending === 'ssn' ? 'Loading…' : 'Show'}<span className="sr-only"> the full number</span></Button>}</span> : null },
        { label: 'Phone', value: fields.phone },
        { label: 'Home address', value: address.length ? address.join(', ') : null, span: true },
        { label: 'Emergency contact', value: fields.emergencyName ? `${fields.emergencyName}${fields.emergencyRelationship ? ` (${fields.emergencyRelationship})` : ''}${fields.emergencyPhone ? ` · ${fields.emergencyPhone}` : ''}` : null, span: true },
        { label: 'License number', value: fields.licenseNumber ? <span className="font-mono">{fields.licenseNumber}</span> : null },
        { label: 'License', value: fields.licenseClass ? `${licenseTypes[fields.licenseClass as LicenseType] ?? fields.licenseClass}${fields.licenseState ? ` · ${fields.licenseState}` : ''}` : null },
        { label: 'License expires', value: date(fields.licenseExpiresOn) }]} />}
      {application?.ssnLast4 && (screener || owns) && <p id="ssn-recorded" className="text-[13px] text-muted-foreground">Viewing the full number is recorded in the activity.{ssn ? ' It hides again after a minute.' : ''}</p>}
      {!confirming && <Notice message={error} error />}
    </CardBody>
    {confirming === 'cancel' && <Dialog open size="sm" tone="danger" onClose={() => setConfirming(null)} busy={pending === 'cancel'} protectChanges={false} closeLabel="Keep link" title="Cancel the link?"
      description="The driver can’t continue until you send a new one. Answers they saved are kept."
      actions={<Button variant="destructive" onClick={() => void cancelLink()}>{pending === 'cancel' ? 'Cancelling…' : 'Cancel link'}</Button>}>
      <Notice message={error} error />
    </Dialog>}
    {confirming === 'send' && <Dialog open size="sm" tone="warning" onClose={() => setConfirming(null)} busy={pending === 'send'} protectChanges={false} title="Send a new link?"
      description={`A new link replaces the current one: the link sent to ${link?.email ?? 'the driver'} stops working right away. Answers they saved are kept.`}
      actions={<Button onClick={() => void sendLink()}>{pending === 'send' ? 'Creating…' : 'Create new link'}</Button>}>
      <Notice message={error} error />
    </Dialog>}
    {sent && <OneTimeLinkDialog link={sent} email={driver.email} onClose={() => setSent(null)} title="Application link created"
      description="Send it to the driver by text or email. It’s shown only now: if it’s lost, create a new one." />}
  </Card>;
}
