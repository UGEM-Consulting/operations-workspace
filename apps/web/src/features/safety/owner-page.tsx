'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Archive, Ellipsis, PenLine, Upload } from 'lucide-react';
import { Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { Button } from '@/components/ui/button';
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
import { useToday } from './driver-documents';
import { OwnerDialog } from './units';
import { unitEventWords, unitKinds, type OwnerDetail } from './units-types';

const contractKinds: Record<string, string> = { IC_AGREEMENT: 'Independent Contractor Agreement', EQUIPMENT_LEASE: 'Equipment Lease Agreement', EQUIPMENT_RECEIPT: 'Equipment receipt', OTHER: 'Other contract' };
const acknowledgements: Record<string, [string, 'success' | 'warning' | 'info']> = { SIGNED: ['Signed', 'success'], OWNER_TO_SIGN: ['Owner to sign', 'warning'], DRIVER_TO_SIGN: ['Driver to sign', 'info'] };
const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;
const contractName = (row: { kind: string; title: string | null }) => row.kind === 'OTHER' ? row.title ?? 'Contract' : contractKinds[row.kind] ?? 'Contract';

/**
 * A truck owner's page (TruckOwnerScreen): the company and who signs for it, the contracts signed on paper as uploaded
 * copies with their dates, its trucks with the drivers on them and their acknowledgement, and its history. Never pay terms,
 * tax IDs or bank details: the terms stay in the paper.
 */
export function OwnerPage({ owner, canArchive }: { owner: OwnerDetail; canArchive: boolean }) {
  const router = useRouter(), toast = useToast();
  const [acting, setActing] = useState<'edit' | 'archive' | 'contract' | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const current = owner.trucks.filter(truck => !truck.archivedAt), contracts = owner.contracts ?? [];
  async function archive() {
    if (pending) return;
    setPending(true); setError('');
    try { await mutate(`safety/owners/${owner.id}/archive`, 'POST', { version: owner.version }); toast({ title: `${owner.name} archived` }); setActing(null); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to archive.')); }
    finally { setPending(false); }
  }
  // An older API sends no contracts; staging may run without storage.
  const canUpload = !owner.archivedAt && owner.contracts !== undefined && owner.storageEnabled !== false;
  const more: MenuEntry[] = owner.archivedAt ? [] : [{ label: 'Edit details', icon: PenLine, onSelect: () => setActing('edit') },
    ...(canArchive ? [{ separator: true } as const, { label: 'Archive owner', icon: Archive, danger: true, onSelect: () => setActing('archive') }] : [])];
  return <div className="space-y-6">
    <PageCrumb label={owner.name} />
    <PageHeader title={owner.name} badge={owner.archivedAt ? <Badge label="Archived" /> : <Badge label="Active" tone="success" />}
      meta={['Truck owner', `${current.length} ${current.length === 1 ? 'truck' : 'trucks'}`]}
      action={<div className="flex flex-wrap gap-2">{canUpload && <Button onClick={() => setActing('contract')}><Upload aria-hidden="true" className="size-4" />Upload signed contract</Button>}
        {more.length > 0 && <DropdownMenu label="More actions" triggerIcon={Ellipsis} align="end" items={more} />}</div>} />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-6">
        {owner.contracts !== undefined && <Card>
          <CardHeader title="Contracts" description="Signed on paper and uploaded here. The terms stay in the paper; nothing in them is typed into the workspace." />
          <Table caption="Contracts" className="mt-3 border-t border-border" rows={contracts} rowKey={row => row.id} columns={[
            { key: 'contract', label: 'Contract', primary: true, cell: row => <>{contractName(row)}{row.unit ? `, unit ${row.unit}` : ''}</> },
            { key: 'signed', label: 'Signed', nowrap: true, cell: row => day(row.signedOn) },
            { key: 'file', label: 'File', hideBelow: 'md', muted: true, cell: row => `${row.pageCount} ${row.pageCount === 1 ? 'page' : 'pages'}${row.uploadedBy ? ` · uploaded by ${row.uploadedBy}` : ''}` },
            { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: row => <ViewDocumentButton variant="outline"
              documents={[{ url: `/api/backend/safety/owners/${owner.id}/contracts/${row.id}/file`, title: contractName(row), meta: <>Signed {day(row.signedOn)}</> }]}>View<span className="sr-only"> {contractName(row)}</span></ViewDocumentButton> }]}
            empty={<EmptyState compact title="No contracts uploaded" description="Upload the signed Independent Contractor Agreement and the equipment lease once they’re signed." />} />
        </Card>}
        <Card>
          <CardHeader title="Trucks" />
          <Table caption="Trucks" className="mt-3 border-t border-border" rows={owner.trucks} rowKey={row => row.id} columns={[
            { key: 'unit', label: 'Unit', primary: true, cell: row => <Link href={`/safety/units/${row.id}`} className="block hover:underline"><Person name={row.number} secondary={`${unitKinds[row.kind]} · ${row.year} ${row.make}`} /></Link> },
            { key: 'driver', label: 'Driver now', cell: row => row.archivedAt ? <Badge label="Archived" /> : row.driverNow ?? <span className="text-muted-foreground">No driver</span> },
            ...(owner.contracts !== undefined ? [{ key: 'ack', label: 'Acknowledgement', hideBelow: 'md' as const,
              cell: (row: OwnerDetail['trucks'][number]) => row.acknowledgement ? <Badge label={acknowledgements[row.acknowledgement][0]} tone={acknowledgements[row.acknowledgement][1]} /> : <span className="text-muted-foreground">—</span> }] : [])]}
            empty={<EmptyState compact title="No trucks yet" description="Add their trucks on Units, choosing this owner." />} />
        </Card>
        <Card>
          <CardHeader title="History" description="Who changed what. Values aren’t kept here." />
          <CardBody>{owner.events.length ? <Timeline items={owner.events.map(row => ({ id: row.id, title: unitEventWords[row.event] ?? row.event, meta: <>{row.actor ?? 'A former account'} · <LocalTime iso={row.createdAt} format="date" /></> }))} />
            : <EmptyState compact title="Nothing yet" />}</CardBody>
        </Card>
      </div>
      <div className="space-y-6 xl:sticky xl:top-20">
        <Card><CardHeader title="Details" /><CardBody className="space-y-3"><DescriptionList layout="rows" items={[{ label: 'Company', value: owner.name },
          { label: 'Signs for it', value: owner.signerName ? `${owner.signerName}${owner.signerTitle ? `, ${owner.signerTitle}` : ''}` : null }, { label: 'Email', value: owner.email }, { label: 'Phone', value: owner.phone }]} />
          <p className="text-[13px] leading-5 text-muted-foreground">Truck owners have no workspace sign-in. They sign through a one-time link and talk with Safety in each truck’s Telegram group.</p></CardBody></Card>
      </div>
    </div>
    {acting === 'edit' && <OwnerDialog owner={owner} onClose={() => setActing(null)} />}
    {acting === 'contract' && <ContractDialog owner={owner} onClose={() => setActing(null)} />}
    {acting === 'archive' && <Dialog open onClose={() => setActing(null)} busy={pending} tone="danger" title={`Archive ${owner.name}?`} description="Only an owner with no trucks in use can be archived. Their history is kept."
      actions={<Button variant="destructive" onClick={() => void archive()}>{pending ? 'Archiving…' : 'Archive'}</Button>}><Notice message={error} error /></Dialog>}
  </div>;
}

/** Uploads a contract signed on paper: one PDF or photos of its pages, with the date it was signed. A newer copy replaces the earlier one, which is kept. */
function ContractDialog({ owner, onClose }: { owner: OwnerDetail; onClose: () => void }) {
  const router = useRouter(), toast = useToast(), today = useToday();
  const [kind, setKind] = useState('IC_AGREEMENT'), [pending, setPending] = useState(false), [error, setError] = useState(''), [fileError, setFileError] = useState('');
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
      await mutate(`safety/owners/${owner.id}/contracts`, 'POST', { version: owner.version, kind, signedOn: String(form.get('signedOn')), ...(kind === 'OTHER' ? { title: String(form.get('title') ?? '') } : {}),
        ...(form.get('unitId') ? { unitId: String(form.get('unitId')) } : {}), ...(pdfs.length ? { file: await fileToBase64(pdfs[0]) } : { pages }) });
      toast({ title: 'Contract uploaded' }); onClose(); router.refresh();
    } catch (failure) { if (failure instanceof PhotoError) setFileError(failure.message); else setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <Dialog open onClose={onClose} busy={pending} title="Upload a signed contract" description={`${owner.name}. The terms stay in the paper; only the signed copy and its date are kept here.`}
    actions={<Button type="submit" form="owner-contract" disabled={pending}>{pending ? 'Uploading…' : <><Upload aria-hidden="true" className="size-4" />Upload</>}</Button>}>
    <form id="owner-contract" onSubmit={submit} className="space-y-4">
      <Select label="Contract" value={kind} onChange={event => setKind(event.target.value)} width="full" options={Object.entries(contractKinds).map(([value, label]) => ({ value, label }))} />
      {kind === 'OTHER' && <Input name="title" label="Name" required maxLength={120} width="full" hint="For example Addendum." />}
      {kind === 'EQUIPMENT_RECEIPT' && <Select name="unitId" label="Truck" required placeholder="Choose a truck" width="full" options={owner.trucks.filter(truck => !truck.archivedAt).map(truck => ({ value: truck.id, label: `${truck.number} · ${unitKinds[truck.kind]}` }))} />}
      <Input name="signedOn" label="Signed on" type="date" required width="sm" max={today ?? undefined} hint={kind === 'EQUIPMENT_RECEIPT' ? 'When possession of the truck passed.' : undefined} />
      <Field id="owner-contract-file" label="Signed copy" hint="One PDF (3 MB maximum), or photos of up to 4 pages in order." error={fileError}>
        <input id="owner-contract-file" name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/heic" multiple required onChange={() => setFileError('')}
          className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>
      <p className="text-[13px] text-muted-foreground">Never pay terms, tax IDs or bank details in the workspace.</p>
      <Notice message={error} error /><PendingHint pending={pending} />
    </form>
  </Dialog>;
}
