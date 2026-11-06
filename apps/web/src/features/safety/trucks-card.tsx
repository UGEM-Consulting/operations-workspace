'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Truck, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Field, Input, Select } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { ViewDocumentButton } from '@/features/documents/document-modal';
import { errorMessage, mutate } from '@/lib/client-api';
import { fileToBase64, MAX_PDF_BYTES } from '@/lib/files';
import { useToday } from './driver-documents';
import { ownerDocumentLabels, type DriverProfile, type TruckRow } from './types';

const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;
type Action = { kind: 'truck'; truck?: TruckRow } | { kind: 'document'; truck: TruckRow } | { kind: 'archive'; truck: TruckRow };

/** An owner-operator's trucks with their lease, insurance and registration PDFs. Dates are typed from the document; nothing is read from the file. */
export function TrucksCard({ driver, canChange }: { driver: DriverProfile; canChange: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [action, setAction] = useState<Action | null>(null);
  const [kind, setKind] = useState<'LEASE' | 'INSURANCE' | 'REGISTRATION'>('INSURANCE');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!driver.trucks) return null;
  const start = (next: Action) => { setAction(next); setError(''); };
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !action) return;
    const form = new FormData(event.currentTarget), text = (name: string) => String(form.get(name) ?? '').trim();
    setPending(true); setError('');
    try {
      const base = `safety/drivers/${driver.id}/trucks`;
      if (action.kind === 'truck') {
        await mutate(action.truck ? `${base}/${action.truck.id}` : base, 'POST', { version: driver.version, unit: text('unit'), vin: text('vin'), year: Number(text('year')), make: text('make'),
          ...(text('plate') ? { plate: text('plate'), plateState: text('plateState') } : {}) });
        toast({ title: action.truck ? 'Truck saved' : 'Truck added' });
      } else if (action.kind === 'document') {
        const file = form.get('file');
        if (!(file instanceof File) || file.type !== 'application/pdf') throw new Error('Choose the document as a PDF file.');
        if (file.size > MAX_PDF_BYTES) throw new Error('The PDF must be 3 MB or smaller.');
        await mutate(`${base}/${action.truck.id}/documents`, 'POST', { version: driver.version, kind, file: await fileToBase64(file), ...(text('expiresOn') ? { expiresOn: text('expiresOn') } : {}) });
        toast({ title: 'Document uploaded' });
      } else {
        await mutate(`${base}/${action.truck.id}/archive`, 'POST', { version: driver.version });
        toast({ title: 'Truck archived' });
      }
      setAction(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  const truck = action && action.kind === 'truck' ? action.truck : undefined;
  return <Card>
    <CardHeader title="Truck and documents" description="The owner-operator’s truck with its lease, insurance and registration. Insurance and registration dates appear in Expiring documents."
      actions={canChange && <Button size="sm" onClick={() => start({ kind: 'truck' })}><Truck aria-hidden="true" className="size-4" />Add truck</Button>} />
    <CardBody>
      {driver.trucks.items.length === 0 ? <EmptyState compact title="No truck on the list" /> : <ul className="divide-y divide-border">
        {driver.trucks.items.map(row => <li key={row.id} className={`py-3 ${row.archivedAt ? 'opacity-60' : ''}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><p className="text-sm font-medium">Unit {row.unit} · {row.year} {row.make}{row.archivedAt && <> <Badge label="Archived" /></>}</p>
              <p className="text-[13px] text-muted-foreground">VIN {row.vin}{row.plate ? ` · Plate ${row.plate} (${row.plateState})` : ''}</p></div>
            {canChange && !row.archivedAt && <span className="flex gap-1"><Button size="sm" variant="outline" onClick={() => start({ kind: 'truck', truck: row })}>Edit</Button>
              <Button size="sm" variant="outline" onClick={() => start({ kind: 'document', truck: row })}><Upload aria-hidden="true" className="size-4" />Upload</Button>
              <Button size="sm" variant="outline" onClick={() => start({ kind: 'archive', truck: row })}>Archive</Button></span>}
          </div>
          <ul className="mt-2 space-y-1">{(['LEASE', 'INSURANCE', 'REGISTRATION'] as const).map(documentKind => {
            const doc = row.documents.find(item => item.kind === documentKind);
            return <li key={documentKind} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{ownerDocumentLabels[documentKind]}: {doc ? <>{doc.expiresOn ? <>expires {day(doc.expiresOn)}</> : 'on file'}{doc.expiresOn && doc.expiresOn < (today ?? '') && <> <Badge label="Expired" tone="danger" /></>}</> : <span className="text-muted-foreground">not uploaded</span>}</span>
              {doc && <ViewDocumentButton documents={[{ url: `/api/backend/safety/drivers/${driver.id}/trucks/${row.id}/documents/${doc.id}/file`, title: `${ownerDocumentLabels[documentKind]} · unit ${row.unit}`, meta: `${doc.pageCount} ${doc.pageCount === 1 ? 'page' : 'pages'}` }]}>View<span className="sr-only"> the {ownerDocumentLabels[documentKind].toLowerCase()}</span></ViewDocumentButton>}
            </li>;
          })}</ul>
        </li>)}</ul>}
    </CardBody>
    {action && <Dialog open onClose={() => setAction(null)} busy={pending} title={action.kind === 'truck' ? (truck ? `Edit unit ${truck.unit}` : 'Add a truck') : action.kind === 'document' ? `Upload for unit ${action.truck.unit}` : `Archive unit ${action.truck.unit}?`}
      description={action.kind === 'archive' ? 'The truck leaves the list and its VIN is free again. Its documents are kept.' : action.kind === 'document' ? 'A PDF of 3 MB or less. A new file replaces the current one of its kind; the earlier file is kept.' : undefined}
      actions={<Button type="submit" form="truck-action" variant={action.kind === 'archive' ? 'destructive' : 'default'}>{pending ? 'Saving…' : action.kind === 'archive' ? 'Archive' : action.kind === 'document' ? 'Upload' : 'Save'}</Button>}>
      <form id="truck-action" onSubmit={submit} className="space-y-4">
        {action.kind === 'truck' && <>
          <Input label="Unit number" name="unit" required maxLength={20} defaultValue={truck?.unit} width="md" />
          <Input label="VIN" name="vin" required maxLength={17} defaultValue={truck?.vin} width="full" hint="17 letters and numbers, never I, O or Q." />
          <Input label="Year" name="year" type="number" required min={1980} max={2100} defaultValue={truck?.year} width="sm" />
          <Input label="Make" name="make" required maxLength={40} defaultValue={truck?.make} width="md" />
          <Input label="License plate" name="plate" optional maxLength={12} defaultValue={truck?.plate ?? ''} width="md" />
          <Input label="Plate state" name="plateState" optional maxLength={2} defaultValue={truck?.plateState ?? ''} width="sm" hint="Two letters. Needed with a plate." />
        </>}
        {action.kind === 'document' && <>
          <Select label="Document" name="kind" required width="full" value={kind} onChange={event => setKind(event.target.value as typeof kind)} options={Object.entries(ownerDocumentLabels).map(([value, label]) => ({ value, label }))} />
          <Field id="truck-file" label="PDF"><input id="truck-file" name="file" type="file" accept="application/pdf" required
            className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>
          <Input label="Expiration date" name="expiresOn" type="date" required={kind !== 'LEASE'} optional={kind === 'LEASE'} min="2000-01-01" width="md" hint="As shown on the document. Don’t enter policy or account numbers." />
        </>}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </Card>;
}
