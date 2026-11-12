'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Save } from 'lucide-react';
import { Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checklist } from '@/components/ui/checklist';
import { Dialog } from '@/components/ui/dialog';
import { DescriptionList } from '@/components/ui/description-list';
import { Input, RadioGroup, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { useToast } from '@/components/ui/toast';
import { Progress } from '@/components/ui/feedback';
import { errorMessage, mutate } from '@/lib/client-api';
import { useToday } from './driver-documents';
import { OneTimeLinkDialog } from './one-time-link-dialog';
import type { DriverProfile } from './types';

export interface PaperItem { key: string; status?: 'ON_FILE' | 'NOT_ON_FILE' | 'NOT_NEEDED'; doneOn?: string | null; note?: string | null; updatedAt?: string; updatedBy?: string | null; hidden?: boolean }
export interface PaperFile { hiredOn: string | null; sourceName: string | null; createdAt: string; addedBy: string | null; keys: string[]; paper: PaperItem[];
  catchUp: { link: { createdAt: string; expiresAt: string; openedAt: string | null; expired: boolean } | null; sentAt: string | null } }

const ITEMS: Record<string, [string, string]> = {
  APPLICATION: ['Employment application', 'The signed application from when they were hired.'],
  MVR_AT_HIRE: ['MVR at hire', 'The motor vehicle record pulled when they were hired.'],
  ROAD_TEST: ['Road test or equivalent', 'A road test certificate, or a CDL accepted in its place.'],
  PREVIOUS_EMPLOYERS: ['Previous employers (3 years)', 'The safety performance history asked of their earlier employers.'],
  DRUG_TEST: ['Pre-employment drug test', 'A negative result before they first drove. On file only: no result is entered.'],
  CLEARINGHOUSE: ['Clearinghouse pre-employment query', 'The full query run before they first drove. On file only.'],
  MEDICAL_REGISTRY: ['Medical examiner registry check', 'The examiner on their current card is on the National Registry.'],
  E_VERIFY: ['E-Verify', 'Case created when they were hired. No case number is recorded.'],
};
// What Not needed means for the two items that can be (PaperFileConfirmScreen).
const NOT_NEEDED: Record<string, string> = { PREVIOUS_EMPLOYERS: 'No DOT-regulated employer in the 3 years before they were hired.', ROAD_TEST: 'Their CDL was accepted in place of a road test.' };
const STATUS: Record<string, string> = { ON_FILE: 'COMPLETED', NOT_ON_FILE: 'BLOCKED', NOT_NEEDED: 'NOT_NEEDED' };
const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;
export const paperLabel = (key: string) => ITEMS[key]?.[0] ?? 'Paper file item';

/** How much of the paper file is confirmed, counting the consent forms the catch-up link asks for. */
export function paperProgress(file: PaperFile) {
  const confirmed = file.paper.filter(item => item.status && item.status !== 'NOT_ON_FILE').length;
  // The paper items only, the same count the Missing details tab shows; the consent forms row follows the catch-up link.
  return { done: confirmed, total: file.keys.length };
}

/**
 * The paper qualification file of a driver added from paper (ExistingDriverProfileScreen): what the folder already holds,
 * confirmed item by item, with nothing retyped. The drug test and Clearinghouse items are seen only by those who see results.
 */
export function PaperFileCard({ driver, file, canWork }: { driver: DriverProfile; file: PaperFile; canWork: boolean }) {
  const router = useRouter(), toast = useToast(), today = useToday();
  const [editing, setEditing] = useState<PaperItem | null>(null), [status, setStatus] = useState('ON_FILE');
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const progress = paperProgress(file);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    try {
      await mutate(`safety/drivers/${driver.id}/paper/${editing.key}`, 'POST', { version: driver.version, status, doneOn: String(form.get('doneOn') ?? ''), note: String(form.get('note') ?? '') });
      toast({ title: `${paperLabel(editing.key)} saved` }); setEditing(null); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  const open = (item: PaperItem) => { setEditing(item); setStatus(item.status ?? 'ON_FILE'); setError(''); };
  const items = file.keys.map(key => file.paper.find(item => item.key === key) ?? { key });
  const consents = driver.consents;
  return <Card>
    <CardHeader title="Paper qualification file" description="What their paper file already holds. Confirm each one; nothing in it is retyped. Anything not on file shows under Missing details until it’s done."
      actions={<Progress label="Confirmed" value={progress.done} max={progress.total} valueLabel={`${progress.done} of ${progress.total}`} />} />
    <Checklist className="mt-3 border-t border-border" items={[...items.map(item => {
      const [title, description] = ITEMS[item.key] ?? [item.key, ''];
      if (item.hidden) return { id: item.key, title, description, status: 'RESTRICTED', meta: 'Seen by the Safety Director and the driver’s Safety Manager, like results.' };
      const what = item.status === 'ON_FILE' ? <>On file on paper{item.doneOn ? <>, {day(item.doneOn)}</> : null}</> : item.status === 'NOT_NEEDED' ? 'Not needed' : item.status === 'NOT_ON_FILE' ? 'Not on file' : null;
      return { id: item.key, title, description, status: item.status ? STATUS[item.status] : 'PENDING', note: item.status !== 'ON_FILE' ? item.note ?? undefined : undefined,
        meta: what ? <>{what}{item.updatedBy ? ` · confirmed by ${item.updatedBy}` : ''}</> : undefined,
        action: canWork ? <Button size="sm" variant={item.status ? 'outline' : 'default'} onClick={() => open(item)}>{item.status ? 'Edit' : 'Confirm'}<span className="sr-only"> {title}</span></Button> : undefined };
    }), { id: 'CONSENTS', title: 'Consent forms', description: 'Background check and Clearinghouse consent, needed for the next MVR and query. The catch-up link asks them to sign the current forms.',
      status: !consents || consents.missing.length === 0 ? 'COMPLETED' : 'PENDING', meta: !consents || consents.missing.length ? undefined : consents.signatures.length ? 'Signed in the workspace' : 'No consent forms are published yet.' }]} />
    {editing && <Dialog open onClose={() => setEditing(null)} busy={pending} title={paperLabel(editing.key)} description={`${driver.firstName} ${driver.lastName} · paper qualification file`}
      actions={<Button type="submit" form="paper-item" disabled={pending}><Save aria-hidden="true" className="size-4" />{pending ? 'Saving…' : 'Save'}</Button>}>
      <form id="paper-item" onSubmit={save} className="space-y-4">
        <RadioGroup name="status" label="In the paper file" value={status} onChange={setStatus} cards options={[
          { value: 'ON_FILE', label: 'On file', description: editing.key === 'PREVIOUS_EMPLOYERS' ? 'The answers, or the record of a good-faith effort, are in the folder.' : 'It’s in the folder.' },
          { value: 'NOT_ON_FILE', label: 'Not on file', description: 'Shows under Missing details until it’s done. It doesn’t put the driver on hold.' },
          ...(NOT_NEEDED[editing.key] ? [{ value: 'NOT_NEEDED', label: 'Not needed', description: NOT_NEEDED[editing.key] }] : [])]} />
        <Input name="doneOn" label="Date" optional type="date" width="sm" max={today ?? undefined} defaultValue={editing.doneOn ?? ''} hint="When it was done, if the paper shows it." />
        <Textarea name="note" label="Note" optional={status === 'ON_FILE'} required={status !== 'ON_FILE'} maxLength={1000} rows={3} defaultValue={editing.note ?? ''} hint="Say what’s missing. No results, medical details or SSNs." />
        <Notice message={error} error />
      </form>
    </Dialog>}
  </Card>;
}

/** The catch-up link's card in the rail: not sent, sent (until when), or done. */
export function CatchUpCard({ driver, file, canWork, onSend }: { driver: DriverProfile; file: PaperFile; canWork: boolean; onSend: () => void }) {
  const router = useRouter(), toast = useToast(), link = file.catchUp.link;
  async function cancel() {
    try { await mutate(`safety/drivers/${driver.id}/catch-up/cancel`, 'POST', { version: driver.version }); toast({ title: 'Link cancelled', description: 'It no longer works.' }); router.refresh(); }
    catch (failure) { toast({ tone: 'danger', title: 'The link wasn’t cancelled', description: errorMessage(failure, 'Reload and try again.') }); }
  }
  const description = link ? (link.expired ? 'The link ran out before they sent anything. Send a new one.' : 'Sent. They photograph their current documents and sign the current forms; the photos count once someone checks them.')
    : file.catchUp.sentAt ? 'They sent their photos and forms. Check each scan under Documents.'
    : 'Not sent yet. The driver photographs their current license, medical card and work authorization and signs the current consent forms. 14 days, with a code emailed to them.';
  return <><Card><CardHeader title="From a paper file" /><CardBody><DescriptionList layout="rows" items={[{ label: 'Hired on', value: file.hiredOn ? <LocalTime iso={`${file.hiredOn}T12:00:00Z`} format="date" /> : null, emptyLabel: 'Not recorded' },
      { label: 'Added', value: <><LocalTime iso={file.createdAt} format="date" />{file.addedBy ? ` by ${file.addedBy}` : ''}{file.sourceName ? `, from ${file.sourceName}` : ''}</> }]} /></CardBody></Card>
    <Card><CardHeader title="Catch-up link" description={description} />
    {(link || file.catchUp.sentAt || canWork) && <CardBody className="space-y-3">
      {link && <DescriptionList layout="rows" items={[{ label: 'Sent', value: <LocalTime iso={link.createdAt} format="date" /> }, { label: link.expired ? 'Ran out' : 'Works until', value: <LocalTime iso={link.expiresAt} format="date" /> },
        { label: 'Opened', value: link.openedAt ? <LocalTime iso={link.openedAt} format="date" /> : 'Not yet' }]} />}
      {file.catchUp.sentAt && !link && <DescriptionList layout="rows" items={[{ label: 'Sent to Safety', value: <LocalTime iso={file.catchUp.sentAt} format="date" /> }]} />}
      {canWork && <div className="flex flex-wrap gap-2">
        {(!link || link.expired) && <Button size="sm" variant={file.catchUp.sentAt ? 'outline' : 'default'} disabled={!driver.email} onClick={onSend}>{link || file.catchUp.sentAt ? 'Send a new link' : 'Send catch-up link'}</Button>}
        {link && !link.expired && <Button size="sm" variant="outline" onClick={() => void cancel()}>Cancel link</Button>}</div>}
      {canWork && !driver.email && <p className="text-[13px] text-muted-foreground">Add their email first: the link works only with that address.</p>}
    </CardBody>}
  </Card></>;
}

/** Makes the link and shows it once; Safety sends it themselves. */
export function CatchUpLinkDialog({ driver, onClose }: { driver: DriverProfile; onClose: () => void }) {
  const router = useRouter();
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null), [pending, setPending] = useState(false), [error, setError] = useState('');
  async function create() {
    if (pending) return;
    setPending(true); setError('');
    try { setLink(await mutate<{ url: string; expiresAt: string }>(`safety/drivers/${driver.id}/catch-up`, 'POST', { version: driver.version })); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to create the link.')); }
    finally { setPending(false); }
  }
  if (link) return <OneTimeLinkDialog link={link} email={driver.email} title="Catch-up link" description={`${driver.firstName} ${driver.lastName} · already drives for UGEM`} onClose={onClose}>
    <p className="text-[13px] text-muted-foreground">Shown once. Send it yourself. Opening it asks for a code emailed to them; it opens only their documents and the current forms. No SSN and no new application.</p>
  </OneTimeLinkDialog>;
  return <Dialog open onClose={onClose} busy={pending} title="Send a catch-up link?" description={`${driver.firstName} photographs their current license, medical card and work authorization and signs the current consent forms. The link works for 14 days.`}
    actions={<Button onClick={() => void create()} disabled={pending}>{pending ? 'Creating…' : 'Create link'}</Button>}>
    <p className="text-sm text-muted-foreground">An open catch-up link stops working when you make a new one. Until someone checks the photos, the dates from the paper file keep counting.</p>
    <Notice message={error} error />
  </Dialog>;
}
