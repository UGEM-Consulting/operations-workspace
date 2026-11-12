'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checklist } from '@/components/ui/checklist';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/feedback';
import { RadioGroup, Select, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Timeline } from '@/components/ui/timeline';
import { useToast } from '@/components/ui/toast';
import { ViewDocumentButton } from '@/features/documents/document-modal';
import { errorMessage, mutate } from '@/lib/client-api';
import { OneTimeLinkDialog } from './one-time-link-dialog';
import { permitShort, type PermitKind } from './units-types';
import type { DriverProfile } from './types';

export type ReadyKey = 'UNIT' | 'ACKNOWLEDGEMENT' | 'BINDER' | 'PERMITS' | 'SAMSARA' | 'DECALS' | 'ORIENTATION' | 'TELEGRAM_GROUP';
type Status = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'NOT_NEEDED';
export interface ReadyStep { key: ReadyKey; status: Status; note?: string | null; updatedAt?: string | null; updatedBy?: string | null; detail?: Record<string, unknown> }
export interface ReadyUnit { id: string; number: string; kind: 'SEMI' | 'PICKUP'; owner: string | null; ownerId: string | null; operatorId: string | null; fromDispatch: boolean }
export interface GroupChange { id: string; reason: 'DISPATCHER_CHANGED' | 'TRUCK_CHANGED' | 'DRIVER_LEFT'; unit: string | null; newUnit: string | null; createdAt: string; doneAt: string | null; doneBy: string | null; remove: string | null; add: string | null }
export interface RoadReady { steps: ReadyStep[]; done: number; total: number; ready: boolean; unit: ReadyUnit | null; groupChanges: GroupChange[]; sharing: string[]; choices: { id: string; number: string; kind: string; owner: string | null }[] }
export interface ContractRow { id: string; unitId: string; unit: string; owner: string; createdAt: string; cancelledAt: string | null; driverSignedAt: string | null; ownerSignedAt: string | null;
  ownerName: string | null; ownerTitle: string | null; link: { purpose: 'CONTRACT' | 'CONTRACT_OWNER'; email: string; createdAt: string; expiresAt: string; openedAt: string | null; expired: boolean } | null }

const ITEMS: Record<ReadyKey, [string, string]> = {
  UNIT: ['Unit', 'The truck they’ll drive, from Units. For an owner-operator, their own.'],
  ACKNOWLEDGEMENT: ['Driver and Contractor Acknowledgement', 'Signed by the driver, then by the truck owner. The workspace fills in both names, the address and the date.'],
  BINDER: ['Truck binder and accident kit', 'Unit number, the driver’s license and medical card, the truck’s and trailer’s registration and inspection, the lease, permits and company documents.'],
  PERMITS: ['Permits in the truck', 'The permits the unit’s type needs, from Units: NY HUT, KYU, NM, OR and IFTA decals for a semi.'],
  SAMSARA: ['Samsara camera and ELD', 'Post the camera box with the unit number in the Samsara Update group. Mark it done when the install video arrives in the Samsara Installation group.'],
  DECALS: ['Decals and signs', 'Company name, USDOT number and unit number on the truck.'],
  ORIENTATION: ['Orientation', 'Rules, the folder, signs and stickers, given by their Safety Manager.'],
  TELEGRAM_GROUP: ['Telegram group', 'One group per truck: office, dispatcher, driver and truck owner. Team drivers in one truck share it. You create it and make office managers admins.'],
};
// The button that finishes each step marked by hand (RoadReadyScreen).
const FINISH: Partial<Record<ReadyKey, string>> = { BINDER: 'Mark done', SAMSARA: 'Mark camera installed', DECALS: 'Mark done', ORIENTATION: 'Mark done', TELEGRAM_GROUP: 'Mark group created' };
const MANUAL: ReadyKey[] = ['BINDER', 'SAMSARA', 'DECALS', 'ORIENTATION', 'TELEGRAM_GROUP'];
const reasons: Record<GroupChange['reason'], string> = { DISPATCHER_CHANGED: 'Dispatcher changed', TRUCK_CHANGED: 'Truck changed', DRIVER_LEFT: 'Driver left' };
const day = (iso: string) => <LocalTime iso={iso} format="date" />;
const done = (step: ReadyStep) => step.status === 'COMPLETED' || step.status === 'NOT_NEEDED';

/** What the header's one main button does for Ready for the road: the next step, named as its finishing action. */
export function readyMain(ready: RoadReady, contracts: ContractRow[]) {
  const open = ready.groupChanges.find(change => !change.doneAt);
  if (open) return { label: 'Mark group updated', target: `group:${open.id}` };
  const next = ready.steps.find(step => !done(step));
  if (!next) return null;
  if (next.key === 'UNIT') return { label: 'Choose unit', target: 'UNIT' };
  if (next.key === 'ACKNOWLEDGEMENT') { const contract = contracts.find(row => row.unitId === ready.unit?.id && !row.cancelledAt);
    return contract?.driverSignedAt ? { label: 'Send owner’s signing link', target: 'OWNER' } : { label: 'Send acknowledgement', target: 'ACKNOWLEDGEMENT' }; }
  if (next.key === 'PERMITS') return null;
  return { label: FINISH[next.key] ?? 'Mark done', target: next.key };
}

/**
 * Ready for the road (RoadReadyScreen, RoadReadyPhoneScreen): after Cleared, eight steps with who did each and when. The unit,
 * the acknowledgement and the permits are read from the records; the rest are marked by hand. Nothing here holds the driver.
 */
export function RoadReadyCard({ driver, ready, contracts, canWork, opened, onOpen }: { driver: DriverProfile; ready: RoadReady; contracts: ContractRow[]; canWork: boolean; opened: string | null; onOpen: (target: string | null) => void }) {
  const router = useRouter(), toast = useToast();
  const [status, setStatus] = useState('COMPLETED'), [pending, setPending] = useState(false), [error, setError] = useState('');
  // Only the Samsara camera waits on others (box photo, install video), so only it asks what's happening.
  const noteNeeded = opened === 'SAMSARA' && status === 'IN_PROGRESS';
  const [link, setLink] = useState<{ url: string; expiresAt: string; email: string | null; owner: boolean; signerName?: string | null } | null>(null);
  const contract = contracts.find(row => row.unitId === ready.unit?.id && !row.cancelledAt) ?? null;
  const step = (key: ReadyKey) => ready.steps.find(item => item.key === key)!;
  async function send(owner: boolean) {
    if (pending) return;
    setPending(true); setError('');
    try {
      const result = await mutate<{ url: string; expiresAt: string; email?: string; signerName?: string | null }>(owner ? `safety/drivers/${driver.id}/contracts/${contract!.id}/owner-link` : `safety/drivers/${driver.id}/contracts`, 'POST', { version: driver.version });
      setLink({ url: result.url, expiresAt: result.expiresAt, email: owner ? result.email ?? null : driver.email, owner, signerName: result.signerName }); onOpen(null); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'The link wasn’t created. Reload and try again.')); }
    finally { setPending(false); }
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !opened) return;
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    try {
      if (opened === 'UNIT') await mutate(`safety/drivers/${driver.id}/road-ready/unit`, 'POST', { version: driver.version, unitId: form.get('unitId') });
      else if (opened.startsWith('group:')) await mutate(`safety/drivers/${driver.id}/group-changes/${opened.slice(6)}/done`, 'POST', { version: driver.version });
      else await mutate(`safety/drivers/${driver.id}/road-ready/${opened}`, 'POST', { version: driver.version, status, note: String(form.get('note') ?? '') });
      toast({ title: 'Saved' }); onOpen(null); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  // Opening a step by hand starts at Done (its button finishes it), with no old error.
  const [shown, setShown] = useState<string | null>(null);
  if (opened !== shown) { setShown(opened); setStatus('COMPLETED'); setError(''); }
  const unit = ready.unit;
  const actionFor = (item: ReadyStep): React.ReactNode => {
    if (!canWork) return undefined;
    if (item.key === 'UNIT') return unit?.fromDispatch ? undefined : <Button size="sm" variant={unit ? 'outline' : 'default'} onClick={() => onOpen('UNIT')}>{unit ? 'Change' : 'Choose unit'}</Button>;
    if (item.key === 'ACKNOWLEDGEMENT') {
      if (item.status === 'NOT_NEEDED' || !unit) return undefined;
      if (contract?.ownerSignedAt) return <ViewDocumentButton variant="outline" documents={[{ url: `/api/backend/safety/drivers/${driver.id}/contracts/${contract.id}/signed`, title: ITEMS.ACKNOWLEDGEMENT[0], meta: `Unit ${contract.unit}` }]}>View</ViewDocumentButton>;
      if (contract?.driverSignedAt) return <Button size="sm" onClick={() => onOpen('OWNER')} disabled={pending}>{contract.link?.purpose === 'CONTRACT_OWNER' ? 'New owner’s link' : 'Send owner’s link'}</Button>;
      return <Button size="sm" variant={contract ? 'outline' : 'default'} onClick={() => onOpen('ACKNOWLEDGEMENT')} disabled={pending}>{contract ? 'Send a new link' : 'Send to the driver'}</Button>;
    }
    if (item.key === 'PERMITS') return unit ? <Button size="sm" variant="outline" asChild><Link href={`/safety/units/${unit.id}`}>Open unit</Link></Button> : undefined;
    return <Button size="sm" variant={done(item) ? 'outline' : 'default'} onClick={() => onOpen(item.key)}>{done(item) ? 'Edit' : FINISH[item.key]}</Button>;
  };
  const metaFor = (item: ReadyStep): React.ReactNode => {
    if (item.key === 'UNIT') return unit ? <>Unit {unit.number} · {unit.kind === 'SEMI' ? 'Semi truck' : 'Pickup'}{unit.operatorId ? ' · their own' : unit.owner ? ` · owner ${unit.owner}` : ''}{unit.fromDispatch ? ' · from Dispatch' : ''}</> : 'Dispatch picks it when assigning, or choose it here first.';
    if (item.key === 'ACKNOWLEDGEMENT') {
      if (item.status === 'NOT_NEEDED') return 'An owner-operator drives their own truck under their lease.';
      if (!contract) return unit ? `Not sent. ${unit.owner ?? 'The truck owner'} signs after the driver.` : 'Choose the unit first.';
      if (contract.ownerSignedAt) return <>Signed by the driver {day(contract.driverSignedAt!)} and by {contract.ownerName}{contract.ownerTitle ? `, ${contract.ownerTitle}` : ''} {day(contract.ownerSignedAt)}</>;
      const waiting = contract.driverSignedAt ? <>Signed by {driver.firstName} {day(contract.driverSignedAt)}. Waiting for {contract.owner}</> : <>Waiting for {driver.firstName}</>;
      return contract.link ? <>{waiting}: link sent to {contract.link.email}, {contract.link.expired ? 'no longer works' : <>works until {day(contract.link.expiresAt)}</>}.</> : <>{waiting}. Send a link.</>;
    }
    if (item.key === 'PERMITS') { const missing = (item.detail?.missing as PermitKind[] | undefined) ?? [];
      return !unit ? 'Choose the unit first.' : missing.length ? `Missing or expired on unit ${unit.number}: ${missing.map(kind => permitShort[kind]).join(', ')}` : `All current on unit ${unit.number}`; }
    return item.updatedAt ? <>{item.status === 'COMPLETED' ? 'Done ' : 'Updated '}{day(item.updatedAt)}{item.updatedBy ? ` · ${item.updatedBy}` : ''}</> : undefined;
  };
  const noteFor = (item: ReadyStep) => item.status === 'IN_PROGRESS' && MANUAL.includes(item.key) ? item.note ?? undefined : undefined;
  const openChange = opened?.startsWith('group:') ? ready.groupChanges.find(change => change.id === opened.slice(6)) : null;
  return <>
    <Card id="road-ready" className="scroll-mt-20">
      <CardHeader title="Ready for the road" description="Each step records who did it and when. Nothing here holds the driver for Dispatch."
        actions={<Progress label="Done" value={ready.done} max={ready.total} valueLabel={`${ready.done} of ${ready.total}`} />} />
      <Checklist className="mt-3 border-t border-border" items={ready.steps.map(item => ({ id: item.key, title: ITEMS[item.key][0], description: ITEMS[item.key][1], status: item.status,
        note: noteFor(item), meta: metaFor(item), action: actionFor(item) }))} />
    </Card>
    {ready.groupChanges.length > 0 && <Card><CardHeader title="Group changes" description="Every change that asked for a group update, and who did it." />
      <CardBody><Timeline items={ready.groupChanges.map(change => ({ id: change.id, title: `${reasons[change.reason]}: update the group${change.unit ? ` for unit ${change.unit}` : ''}`,
        meta: change.doneAt ? <>Done by {change.doneBy ?? 'a former account'} · {day(change.doneAt)}</> : <>Asked {day(change.createdAt)} · waiting</> }))} /></CardBody></Card>}
    {opened && (MANUAL.includes(opened as ReadyKey) || opened === 'UNIT' || openChange) && <Dialog open onClose={() => onOpen(null)} busy={pending}
      title={opened === 'UNIT' ? 'Choose the unit' : openChange ? `Update the Telegram group${openChange.unit ? ` for unit ${openChange.unit}` : ''}` : ITEMS[opened as ReadyKey][0]}
      description={opened === 'UNIT' ? 'The truck they’ll drive until Dispatch assigns one. Dispatch’s choice replaces it.' : openChange ? 'The workspace can’t change Telegram groups. Mark it done once you have.' : ITEMS[opened as ReadyKey][1]}
      actions={<Button type="submit" form="road-ready-step" disabled={pending}>{pending ? 'Saving…' : openChange ? 'Mark group updated' : 'Save'}</Button>}>
      <form id="road-ready-step" onSubmit={save} className="space-y-4">
        {opened === 'UNIT' ? <Select name="unitId" label="Unit" required placeholder="Choose a unit" width="full" defaultValue={unit?.id ?? ''}
          options={ready.choices.map(choice => ({ value: choice.id, label: `${choice.number} · ${choice.kind === 'SEMI' ? 'Semi truck' : 'Pickup'}${choice.owner ? ` · ${choice.owner}` : ''}` }))}
          hint={driver.driverType === 'OWNER_OPERATOR' ? 'Their own trucks from Units.' : 'Truck owners’ trucks from Units.'} />
        : openChange ? <ul className="list-disc space-y-1 pl-5 text-sm">{openChange.remove && <li>Remove {openChange.remove}{openChange.reason === 'DRIVER_LEFT' ? `: ${driver.firstName} left.` : '.'}</li>}
            {openChange.reason === 'DRIVER_LEFT' && <li>Remove {driver.firstName}.</li>}{openChange.add && <li>Add {openChange.add}, their new dispatcher.</li>}
            {openChange.newUnit && <li>Move {driver.firstName} to the group for unit {openChange.newUnit}.</li>}</ul>
        : <>
          <RadioGroup name="status" label="Where it stands" value={status} onChange={setStatus} options={[{ value: 'PENDING', label: 'Not started' }, { value: 'IN_PROGRESS', label: 'In progress', ...(opened === 'SAMSARA' ? { description: 'Say what’s happening in the note.' } : {}) }, { value: 'COMPLETED', label: 'Done' }]} />
          <Textarea name="note" label="Note" optional={!noteNeeded} required={noteNeeded} maxLength={500} rows={2} defaultValue={step(opened as ReadyKey).note ?? ''} hint="No medical details or SSNs." />
        </>}
        <Notice message={error} error />
      </form>
    </Dialog>}
    {(opened === 'ACKNOWLEDGEMENT' || opened === 'OWNER') && <Dialog open onClose={() => onOpen(null)} busy={pending}
      title={opened === 'OWNER' ? `Link for ${contract?.owner ?? 'the truck owner'}` : `Send the acknowledgement to ${driver.firstName}?`}
      description={opened === 'OWNER' ? `${driver.firstName} signed. Now the truck owner signs as the contractor, through a link bound to the email on the owner’s page. 7 days, with an emailed code.`
        : `A link for ${driver.firstName} to read and sign the Driver and Contractor Acknowledgement for unit ${unit?.number ?? ''}. 7 days, with a code emailed to them. The truck owner signs after.`}
      actions={<Button onClick={() => void send(opened === 'OWNER')} disabled={pending}>{pending ? 'Creating…' : 'Create link'}</Button>}>
      <p className="text-sm text-muted-foreground">A link already out for this signer stops working when you make a new one.</p>
      <Notice message={error} error />
    </Dialog>}
    {link && <OneTimeLinkDialog link={link} email={link.email} title={link.owner ? 'Link for the truck owner' : 'Link for the driver'} onClose={() => setLink(null)}
      footer={<>It works until <LocalTime iso={link.expiresAt} format="date" /> and only with {link.email}; {link.owner ? 'the signer gets' : 'the driver gets'} a code by email each time they open it.</>}
      description={`Driver and Contractor Acknowledgement · ${driver.firstName} ${driver.lastName} · unit ${unit?.number ?? ''}`}>
      {link.owner && <DescriptionList layout="rows" items={[{ label: 'Owner', value: contract?.owner ?? unit?.owner ?? '' }, { label: 'Signer', value: link.signerName ? `${link.signerName}, from the owner’s page` : 'Whoever signs for the owner' }, { label: 'Sent to', value: link.email }]} />}
      <p className="text-[13px] text-muted-foreground">Shown once. Send it yourself{link.owner ? ', in the owner’s Telegram group or by email' : ''}. Opening it asks for a code emailed to them; the link opens only this document.</p>
    </OneTimeLinkDialog>}
  </>;
}

/** The alert above the page while a Telegram group update waits (GroupChangeTaskScreen). */
export function GroupChangeAlert({ driver, ready, onDone }: { driver: DriverProfile; ready: RoadReady; onDone?: (target: string) => void }) {
  const open = ready.groupChanges.filter(change => !change.doneAt);
  if (!open.length) return null;
  return <>{open.map(change => <Alert key={change.id} tone="warning" title={`Update the Telegram group${change.unit ? ` for unit ${change.unit}` : ''}`}
    action={onDone ? <Button size="sm" variant="outline" onClick={() => onDone(`group:${change.id}`)}>Mark group updated</Button> : undefined}>
    <ul className="list-disc space-y-1 pl-5">
      {change.remove && <li>Remove {change.remove}: {change.reason === 'DRIVER_LEFT' ? `${driver.firstName} left` : `Dispatch moved ${driver.firstName} to another dispatcher`} on <LocalTime iso={change.createdAt} format="date" />.</li>}
      {change.add && <li>Add {change.add}, their new dispatcher.</li>}
      {change.newUnit && <li>{driver.firstName} moved to unit {change.newUnit}: add them to that truck’s group.</li>}
    </ul>
    {ready.sharing.length > 0 && <p className="mt-2">{ready.sharing.join(' and ')} {ready.sharing.length === 1 ? 'shares' : 'share'} the truck, so this one step covers {ready.sharing.length === 1 ? 'both drivers' : 'every driver in it'}.</p>}
  </Alert>)}</>;
}
