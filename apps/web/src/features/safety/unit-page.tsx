'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Archive, CalendarClock, Ellipsis, PenLine, Upload, UserRound, Wrench } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { DropdownMenu, type MenuEntry } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { Timeline } from '@/components/ui/timeline';
import { useToast } from '@/components/ui/toast';
import { PageCrumb } from '@/components/shell-context';
import { PageHeader } from '@/components/workspace-ui';
import { ViewDocumentButton } from '@/features/documents/document-modal';
import { imageForUpload, PhotoError } from '@/features/onboarding/photo';
import { errorMessage, mutate } from '@/lib/client-api';
import { fileToBase64, MAX_PDF_BYTES } from '@/lib/files';
import { DateCell, UnitDialog } from './units';
import { daysLeft, inspectionDue, permitLabels, unitEventWords, unitFileLabels, unitKinds, unitStatus, type Choice, type PermitKind, type UnitDetail, type UnitList, type UnitRow } from './units-types';

const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;
type Acting = 'dates' | 'edit' | 'file' | 'responsible' | 'archive' | null;

/**
 * A truck's or trailer's page (UnitProfileScreen, UnitProfilePhoneScreen, TrailerScreen): one main button (Update dates),
 * the dates and permits, who drove or pulled it, the trailer it pulls now and a history without values. Everything else
 * is under More actions, with Archive last.
 */
export function UnitPage({ unit, choices, canChange }: { unit: UnitDetail; choices: Pick<UnitList, 'next' | 'choices'>; canChange: boolean }) {
  const router = useRouter(), toast = useToast();
  const [acting, setActing] = useState<Acting>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const trailer = unit.kind === 'TRAILER', archived = !!unit.archivedAt;
  const due = inspectionDue(unit.inspectedOn);
  const soon = [{ what: 'Registration', date: unit.registrationExpiresOn }, { what: 'Yearly inspection', date: due }, ...unit.permits.map(permit => ({ what: permitLabels[permit.kind], date: permit.expiresOn }))]
    .filter(item => item.date && daysLeft(item.date, unit.today) <= 60).sort((a, b) => a.date!.localeCompare(b.date!));
  async function status(next: 'IN_SERVICE' | 'OUT_OF_SERVICE' | 'ARCHIVED') {
    if (pending) return;
    setPending(true); setError('');
    try {
      await mutate(`safety/units/${unit.id}/status`, 'POST', { version: unit.version, status: next });
      toast({ title: next === 'ARCHIVED' ? `Unit ${unit.number} archived` : next === 'OUT_OF_SERVICE' ? 'Marked out of service' : 'Back in service' });
      setActing(null); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to save.')); }
    finally { setPending(false); }
  }
  const more: MenuEntry[] = canChange && !archived ? [
    { label: 'Edit details', icon: PenLine, onSelect: () => setActing('edit') },
    ...(unit.storageEnabled ? [{ label: 'Add a file', icon: Upload, onSelect: () => setActing('file') }] : []),
    { label: 'Change responsible', icon: UserRound, onSelect: () => setActing('responsible') },
    unit.outOfServiceAt ? { label: 'Back in service', icon: Wrench, onSelect: () => void status('IN_SERVICE') } : { label: 'Mark out of service', icon: Wrench, onSelect: () => void status('OUT_OF_SERVICE') },
    { separator: true }, { label: `Archive ${trailer ? 'trailer' : 'unit'}`, icon: Archive, danger: true, onSelect: () => setActing('archive') }] : [];
  const asRow: UnitRow = { ...unit, permits: unit.permits, driverNow: null };
  return <div className="space-y-6">
    <PageCrumb label={`Unit ${unit.number}`} />
    <PageHeader title={trailer ? `Trailer ${unit.number}` : `Unit ${unit.number}`} badge={<Badge {...unitStatus(unit)} />}
      meta={[trailer ? unit.trailerType ?? 'Trailer' : unitKinds[unit.kind], unit.ownerKind === 'COMPANY' ? 'Company trailer' : `Owner ${unit.owner ?? ''}`, `${unit.year} ${unit.make}`, ...(unit.responsible ? [`Responsible ${unit.responsible}`] : [])]}
      action={<div className="flex gap-2">{canChange && !archived && <Button onClick={() => setActing('dates')}><CalendarClock aria-hidden="true" className="size-4" />Update dates</Button>}
        {more.length > 0 && <DropdownMenu label="More actions" triggerIcon={Ellipsis} align="end" items={more} />}</div>} />
    {soon.length > 0 && !archived && <Alert tone={soon.some(item => daysLeft(item.date!, unit.today) < 0) ? 'danger' : 'warning'} title={`${soon[0].what} ${daysLeft(soon[0].date!, unit.today) < 0 ? 'expired' : 'due'} ${new Date(`${soon[0].date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`}>
      Record the new date once it’s done.{unit.responsible ? ` ${unit.responsible} gets the reminders.` : ''}</Alert>}
    <Notice message={error} error />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader title="Dates" description="These appear in Expiring documents and the reminders. Add a file only if you want it here as well." />
          <Table caption="Unit dates" className="mt-3 border-t border-border" rows={[
            { key: 'registration', what: 'Registration', date: <DateCell value={unit.registrationExpiresOn} today={unit.today} />, file: unit.files.find(file => file.kind === 'REGISTRATION') },
            { key: 'inspection', what: 'Yearly inspection', date: unit.inspectedOn ? <>Done {day(unit.inspectedOn)} · due <DateCell value={due} today={unit.today} /></> : <span className="text-muted-foreground">Not recorded</span>, file: unit.files.find(file => file.kind === 'INSPECTION') },
            ...unit.ownerDocuments.filter(doc => doc.kind !== 'REGISTRATION').map(doc => ({ key: doc.id, what: doc.kind === 'LEASE' ? 'Lease to the carrier' : 'Insurance', date: doc.expiresOn ? <DateCell value={doc.expiresOn} today={unit.today} /> : 'On file',
              file: undefined, link: unit.driverId ? <Link className="underline" href={`/safety/drivers/${unit.driverId}`}>On the driver’s page</Link> : undefined }))]}
            rowKey={row => row.key} columns={[
              { key: 'what', label: 'Document', primary: true, cell: row => row.what },
              { key: 'date', label: 'Date', cell: row => row.date },
              { key: 'file', label: 'File', hideBelow: 'md', cell: row => 'link' in row && row.link ? row.link : row.file
                ? <ViewDocumentButton documents={[{ url: `/api/backend/safety/units/${unit.id}/files/${row.file.id}/file`, title: `${unitFileLabels[row.file.kind]} · unit ${unit.number}`, meta: `${row.file.pageCount} ${row.file.pageCount === 1 ? 'page' : 'pages'}` }]}>View</ViewDocumentButton>
                : <span className="text-muted-foreground">In DataTruck</span> }]} />
        </Card>
        {unit.permitsNeeded.length > 0 && <Card>
          <CardHeader title="Permits" description={`What a ${unitKinds[unit.kind].toLowerCase()} needs. Most end Dec 31; renew them together from Expiring documents.`} />
          <Table caption="Permits" className="mt-3 border-t border-border" rows={unit.permitsNeeded.map(kind => ({ kind, expiresOn: unit.permits.find(permit => permit.kind === kind)?.expiresOn ?? null }))} rowKey={row => row.kind} columns={[
            { key: 'permit', label: 'Permit', primary: true, cell: row => permitLabels[row.kind] },
            { key: 'expires', label: 'Expires', cell: row => <DateCell value={row.expiresOn} today={unit.today} missing="Missing" /> },
            { key: 'status', label: 'Status', cell: row => !row.expiresOn ? <Badge label="Missing" tone="danger" /> : daysLeft(row.expiresOn, unit.today) < 0 ? <Badge label="Expired" tone="danger" /> : <Badge label="Current" tone="success" /> }]} />
        </Card>}
        <Card>
          <CardHeader title={trailer ? 'With' : 'Drivers'} description={trailer ? 'From Dispatch’s assignments of the truck and trailer.' : 'From Dispatch’s assignments. Team drivers share a truck.'} />
          <CardBody>{unit.drivers.length ? <ul className="divide-y divide-border">{unit.drivers.map(row => <li key={row.id} className="py-2 text-sm">
            <p className="font-medium"><Link className="hover:underline" href={`/safety/drivers/${row.driverId}`}>{row.driver}</Link>{!row.endedAt && <> <Badge label="Now" tone="info" /></>}</p>
            <p className="text-[13px] text-muted-foreground">{row.endedAt ? <>{day(row.startedAt.slice(0, 10))} to {day(row.endedAt.slice(0, 10))}</> : <>Since {day(row.startedAt.slice(0, 10))}</>} · {row.dispatcher}, {row.mc}</p></li>)}</ul>
            : <EmptyState compact title="Nobody yet" description="Dispatch picks the unit when it assigns a driver." />}</CardBody>
        </Card>
        <Card>
          <CardHeader title="History" description="Who changed what. Values aren’t kept here." />
          <CardBody>{unit.events.length ? <Timeline items={unit.events.map(row => ({ id: row.id, title: unitEventWords[row.event] ?? row.event, meta: <>{row.actor ?? 'A former account'} · <LocalTime iso={row.createdAt} format="date" /></> }))} />
            : <EmptyState compact title="Nothing yet" />}</CardBody>
        </Card>
      </div>
      <div className="space-y-6 xl:sticky xl:top-20">
        <Card><CardHeader title="Details" /><CardBody><DescriptionList layout="rows" items={[
          { label: trailer ? 'Trailer' : 'Unit', value: unit.number }, { label: 'Type', value: trailer ? unit.trailerType ?? 'Trailer' : unitKinds[unit.kind] },
          { label: 'Owner', value: unit.ownerKind === 'COMPANY' ? 'The company' : unit.ownerKind === 'OWNER' && unit.ownerId ? <Link className="underline" href={`/safety/owners/${unit.ownerId}`}>{unit.owner}</Link>
            : unit.driverId ? <Link className="underline" href={`/safety/drivers/${unit.driverId}`}>{unit.owner}</Link> : unit.owner },
          { label: 'VIN', value: <span className="font-mono">{unit.vin}</span> }, { label: 'Plate', value: unit.plate ? `${unit.plate}${unit.plateState ? ` (${unit.plateState})` : ''}` : null },
          { label: 'Year and make', value: `${unit.year} ${unit.make}` }]} /></CardBody></Card>
        {!trailer && <Card><CardHeader title="Trailer now" /><CardBody>{unit.trailerNow.length ? unit.trailerNow.map(row => <Link key={row.id} href={`/safety/units/${row.id}`} className="block hover:underline"><Person name={row.number} secondary={row.trailerType ?? 'Trailer'} /></Link>)
          : <p className="text-sm text-muted-foreground">None</p>}</CardBody></Card>}
        <Card><CardHeader title="Responsible" /><CardBody>{unit.responsible ? <Person name={unit.responsible} secondary="Safety Manager · gets this unit’s reminders" /> : <p className="text-sm text-muted-foreground">Nobody yet: the Safety Director gets its reminders.</p>}</CardBody></Card>
      </div>
    </div>
    {acting === 'dates' && <DatesDialog unit={unit} onClose={() => setActing(null)} />}
    {acting === 'edit' && <UnitDialog data={choices} kind={unit.kind} unit={asRow} onClose={() => setActing(null)} />}
    {acting === 'file' && <FileDialog unit={unit} onClose={() => setActing(null)} />}
    {acting === 'responsible' && <ResponsibleDialog unit={unit} staff={choices.choices.staff} onClose={() => setActing(null)} />}
    {acting === 'archive' && <Dialog open onClose={() => setActing(null)} busy={pending} tone="danger" title={`Archive ${trailer ? 'trailer' : 'unit'} ${unit.number}?`}
      description="It leaves the list Dispatch picks from and its dates stop counting. Its history and files are kept, and its number is free again."
      actions={<Button variant="destructive" onClick={() => void status('ARCHIVED')}>{pending ? 'Archiving…' : 'Archive'}</Button>}><Notice message={error} error /></Dialog>}
  </div>;
}

/** Update dates: the registration, the yearly inspection and each permit the type carries. Only what changed is sent. */
function DatesDialog({ unit, onClose }: { unit: UnitDetail; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget), value = (key: string) => String(form.get(key) ?? '').trim();
    const permits = unit.permitsNeeded.map(kind => ({ kind, expiresOn: value(`permit-${kind}`) })).filter(row => row.expiresOn && row.expiresOn !== unit.permits.find(permit => permit.kind === row.kind)?.expiresOn);
    const body = { version: unit.version, ...(value('registrationExpiresOn') !== (unit.registrationExpiresOn ?? '') ? { registrationExpiresOn: value('registrationExpiresOn') } : {}),
      ...(value('inspectedOn') !== (unit.inspectedOn ?? '') ? { inspectedOn: value('inspectedOn') } : {}), ...(permits.length ? { permits } : {}) };
    setPending(true); setError('');
    try { await mutate(`safety/units/${unit.id}/dates`, 'POST', body); toast({ title: 'Dates saved' }); onClose(); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <Dialog open onClose={onClose} busy={pending} title="Update dates" description={`Unit ${unit.number} · what the papers say`} actions={<Button type="submit" form="unit-dates" disabled={pending}>{pending ? 'Saving…' : 'Save dates'}</Button>}>
    <form id="unit-dates" onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Registration expires" name="registrationExpiresOn" type="date" optional width="full" defaultValue={unit.registrationExpiresOn ?? ''} />
        <Input label="Last yearly inspection" name="inspectedOn" type="date" optional width="full" defaultValue={unit.inspectedOn ?? ''} hint="Due again 12 months later." />
      </div>
      {unit.permitsNeeded.length > 0 && <fieldset className="space-y-3"><legend className="text-sm font-medium">Permits</legend>
        <div className="grid gap-4 sm:grid-cols-2">{unit.permitsNeeded.map((kind: PermitKind) => <Input key={kind} label={permitLabels[kind]} name={`permit-${kind}`} type="date" optional width="full"
          defaultValue={unit.permits.find(permit => permit.kind === kind)?.expiresOn ?? ''} />)}</div></fieldset>}
      <Notice message={error} error /><PendingHint pending={pending} />
    </form>
  </Dialog>;
}

/** An optional copy of a paper: one PDF, or photos of up to four pages in order. */
function FileDialog({ unit, onClose }: { unit: UnitDetail; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [fileError, setFileError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget), files = (form.getAll('file') as File[]).filter(file => file.size > 0);
    setPending(true); setError(''); setFileError('');
    try {
      const pdfs = files.filter(file => file.type === 'application/pdf');
      if (!files.length) throw new PhotoError('Choose a PDF, or photos of each page.');
      if (pdfs.length && files.length > 1) throw new PhotoError('Choose one PDF, or photos only.');
      if (pdfs.length && pdfs[0].size > MAX_PDF_BYTES) throw new PhotoError('The PDF is larger than 3 MB.');
      if (files.length > 4) throw new PhotoError('Choose at most 4 photos, one per page, or upload a PDF.');
      const pages: string[] = [];
      if (!pdfs.length) for (const file of files) pages.push(await imageForUpload(file, { maxSide: 1800, maxBytes: 760_000 }));
      await mutate(`safety/units/${unit.id}/files`, 'POST', { version: unit.version, kind: String(form.get('kind')), ...(pdfs.length ? { file: await fileToBase64(pdfs[0]) } : { pages }) });
      toast({ title: 'File added' }); onClose(); router.refresh();
    } catch (failure) { if (failure instanceof PhotoError) setFileError(failure.message); else setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <Dialog open onClose={onClose} busy={pending} title="Add a file" description="Optional: the papers live in DataTruck and the binder. A file replaces the earlier one of its kind, which is kept."
    actions={<Button type="submit" form="unit-file" disabled={pending}>{pending ? 'Saving…' : <><Upload aria-hidden="true" className="size-4" />Add file</>}</Button>}>
    <form id="unit-file" onSubmit={submit} className="space-y-4">
      <Select label="Which paper" name="kind" width="full" defaultValue="REGISTRATION" options={Object.entries(unitFileLabels).map(([value, label]) => ({ value, label }))} />
      <Field id="unit-file-input" label="File" hint="One PDF (3 MB maximum), or photos of up to 4 pages in order." error={fileError}>
        <input id="unit-file-input" name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/heic" multiple required onChange={() => setFileError('')}
          className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>
      <Notice message={error} error /><PendingHint pending={pending} />
    </form>
  </Dialog>;
}

function ResponsibleDialog({ unit, staff, onClose }: { unit: UnitDetail; staff: Choice[]; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError('');
    try { await mutate(`safety/units/${unit.id}/responsible`, 'POST', { version: unit.version, responsibleId: String(new FormData(event.currentTarget).get('responsibleId')) }); toast({ title: 'Responsible changed' }); onClose(); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to save.')); }
    finally { setPending(false); }
  }
  return <Dialog open onClose={onClose} busy={pending} title="Change responsible" description="The Safety Manager who gets this unit’s reminders." actions={<Button type="submit" form="unit-responsible" disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>}>
    <form id="unit-responsible" onSubmit={submit} className="space-y-4">
      <Select label="Responsible" name="responsibleId" required width="full" placeholder="Choose a Safety Manager" defaultValue={unit.responsibleId ?? ''} options={staff.map(item => ({ value: item.id, label: item.name }))} />
      <Notice message={error} error />
    </form>
  </Dialog>;
}
