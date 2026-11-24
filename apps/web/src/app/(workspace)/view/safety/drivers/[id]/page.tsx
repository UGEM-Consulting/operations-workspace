import Link from 'next/link';
import { requirePage } from '@/lib/auth';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checklist, type ChecklistItem } from '@/components/ui/checklist';
import { DescriptionList } from '@/components/ui/description-list';
import { LocalTime } from '@/components/ui/local-time';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { driverBadge, driverTypes, documentLabels, licenseTypes, type DocumentKind, type DriverType, type LicenseType } from '@/features/safety/types';
import { OpenFile } from '@/features/view/files';
import { LookNote, NotAvailable, viewRead, ViewOnlyMark } from '@/features/view/ui';
export const metadata = { title: 'Driver · view only' };

interface ViewDriver {
  id: string; firstName: string; lastName: string; phone: string; driverType: DriverType; licenseType: LicenseType | null; licenseState: string | null; status: string;
  clearedAt: string | null; closedAt: string | null; createdAt: string; owner: { id: string; name: string } | string | null;
  hold: { onHold: boolean; review: boolean; documents: boolean };
  clearance: { key: string; status: string; doneOn?: string | null }[];
  documents: { id: string | null; kind: DocumentKind; subtype: string | null; expiresOn: string | null; verifiedAt: string | null; fromPaper: boolean }[];
  paperFile: { hiredOn: string | null; items: { key: string; status: string; doneOn?: string | null }[] } | null;
  annual: { dueOn: string | null; items: { reviewedOn: string; outcome: string; fromPaper: boolean }[] };
  work: { mc: string; dispatcher: string; unit: string | null; unitKind: string | null; trailer: string | null; startedAt: string } | null;
  withFiles: boolean; consents: { documentId: string; kind: string; title: string; version: number; signedAt: string }[] | null;
}
const ITEMS: Record<string, string> = { APPLICATION: 'Employment application', MVR_AT_HIRE: 'MVR at hire', ROAD_TEST: 'Road test or equivalent', PREVIOUS_EMPLOYERS: 'Previous employers (3 years)',
  DRUG_TEST: 'Pre-employment drug test', CLEARINGHOUSE: 'Clearinghouse query', MEDICAL_REGISTRY: 'Medical examiner registry check', E_VERIFY: 'E-Verify' };
const PAPER: Record<string, string> = { ON_FILE: 'COMPLETED', NOT_ON_FILE: 'BLOCKED', NOT_NEEDED: 'NOT_NEEDED', RESTRICTED: 'RESTRICTED' };
const UNIT: Record<string, string> = { SEMI: 'Semi truck', PICKUP: 'Pickup', TRAILER: 'Trailer' };
const SUBTYPE: Record<string, string> = { US_PASSPORT: 'US passport', GREEN_CARD: 'Green card', WORK_PERMIT: 'Work permit', OTHER: 'Other document' };
const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;
const RESTRICTED = 'Only the Safety Director and their Safety Manager see this result';

/**
 * A driver read only (ViewOnlyDriverScreen): status, hold and why (a test never counts toward a viewer's hold, 49 CFR 40.321), clearance
 * steps, document dates, the yearly review and who they work with. Test results show as Restricted; nothing changes a step.
 */
export default async function ViewDriverPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePage('viewdrivers');
  const { id } = await params;
  const driver = /^[0-9a-f-]{36}$/i.test(id) ? await viewRead<ViewDriver>(`safety/drivers/${id}`, 'driver') : null;
  if (!driver) return <NotAvailable back="/view/safety/drivers" label="Drivers" />;
  const name = `${driver.firstName} ${driver.lastName}`, badge = driverBadge(driver.status), today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const owner = typeof driver.owner === 'string' ? driver.owner : driver.owner?.name ?? null;
  const reasons = [driver.hold.documents && 'Their driver’s license or medical card has expired. A newer one, once Safety checks it, lifts this.', driver.hold.review && 'Their last yearly review found them not qualified.'].filter(Boolean) as string[];
  const clearance: ChecklistItem[] = (driver.paperFile ? driver.paperFile.items.map(item => ({ id: item.key, title: ITEMS[item.key] ?? item.key, status: PAPER[item.status] ?? item.status,
    meta: item.status === 'RESTRICTED' ? RESTRICTED : item.status === 'ON_FILE' ? <>On file on paper{item.doneOn ? <> · {day(item.doneOn)}</> : null}</> : item.status === 'NOT_ON_FILE' ? 'Not on file yet' : undefined }))
    : driver.clearance.map(item => ({ id: item.key, title: ITEMS[item.key] ?? item.key, status: item.status === 'ACCEPTED' ? 'NOT_NEEDED' : item.status,
      meta: item.status === 'RESTRICTED' ? RESTRICTED : item.status === 'ACCEPTED' ? 'CDL accepted' : item.doneOn ? <>Done {day(item.doneOn)}</> : undefined })));
  return <div className="space-y-6">
    <PageHeader title={name} badge={<span className="flex flex-wrap items-center gap-2"><Badge label={badge.label} tone={badge.tone} /><ViewOnlyMark /></span>}
      meta={[driverTypes[driver.driverType] ?? driver.driverType, [driver.licenseType ? licenseTypes[driver.licenseType] : null, driver.licenseState].filter(Boolean).join(' · '), owner ? `Safety Manager ${owner}` : null, driver.paperFile ? 'From a paper file' : null].filter(Boolean) as string[]} />
    {driver.hold.onHold && <Alert tone="danger" title="On hold: Dispatch can’t assign this driver">{reasons.length ? <ul className="list-disc space-y-0.5 pl-4">{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p>Safety knows why.</p>}</Alert>}
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
      <div className="space-y-6">
        {(clearance.length > 0) && <Card><CardHeader title="Clearance" description="What Safety has on file before this driver runs loads. Results stay with Safety." /><Checklist className="mt-3 border-t border-border" items={clearance} /></Card>}
        <Card>
          <CardHeader title="Documents" description={driver.withFiles ? 'Expiration dates, and the scans an administrator let you open. Each one you open is recorded.' : 'Expiration dates only. The scans stay with Safety.'} />
          <Table caption="Documents" className="mt-3 border-t border-border" rows={driver.documents} rowKey={doc => doc.kind} columns={[
            { key: 'doc', label: 'Document', primary: true, cell: doc => <>{documentLabels[doc.kind] ?? doc.kind}{doc.subtype && <span className="block text-[13px] text-muted-foreground">{SUBTYPE[doc.subtype] ?? doc.subtype}</span>}</> },
            { key: 'expires', label: 'Expires', nowrap: true, cell: doc => doc.expiresOn ? <span className="flex flex-wrap items-center gap-1.5">{day(doc.expiresOn)}{doc.expiresOn < today && <Badge label="Expired" tone="danger" />}</span> : <span className="text-muted-foreground">{doc.kind === 'WORK_AUTHORIZATION' ? 'Not rechecked' : '—'}</span> },
            { key: 'checked', label: 'Checked', muted: true, cell: doc => doc.fromPaper ? 'From the paper file' : doc.verifiedAt ? <LocalTime iso={doc.verifiedAt} format="date" /> : 'Not checked yet' },
            ...(driver.withFiles ? [{ key: 'open', label: 'Actions', srOnly: true, action: true, align: 'right' as const, cell: (doc: ViewDriver['documents'][number]) => doc.id ? <OpenFile url={`/api/backend/view/safety/drivers/${driver.id}/documents/${doc.id}/file`} title={documentLabels[doc.kind] ?? doc.kind} label={`View ${documentLabels[doc.kind] ?? doc.kind}`} /> : null }] : []),
          ]} empty={<p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">No documents on record yet.</p>} />
        </Card>
        {driver.withFiles && driver.consents && driver.consents.length > 0 && <Card>
          <CardHeader title="Signed consent forms" description="Each one you open is recorded." />
          <Table caption="Signed consent forms" className="mt-3 border-t border-border" rows={driver.consents} rowKey={form => form.documentId} columns={[
            { key: 'title', label: 'Form', primary: true, cell: form => `${form.title} · version ${form.version}` },
            { key: 'signed', label: 'Signed', muted: true, cell: form => <LocalTime iso={form.signedAt} format="date" /> },
            { key: 'open', label: 'Actions', srOnly: true, action: true, align: 'right', cell: form => <OpenFile url={`/api/backend/view/safety/drivers/${driver.id}/consents/${form.documentId}/signed`} title={form.title} label={`View ${form.title}`} /> },
          ]} />
        </Card>}
        <Card><CardHeader title="Yearly review" description={driver.annual.dueOn ? <>Next due <strong>{day(driver.annual.dueOn)}</strong>.</> : 'Not due yet.'} /><CardBody>
          {driver.annual.items.length ? <ul className="space-y-3">{driver.annual.items.slice(0, 5).map(item => <li key={item.reviewedOn}><p className="text-sm font-medium">{day(item.reviewedOn)} · {item.outcome === 'QUALIFIED' ? 'Qualified' : 'Not qualified'}</p>{item.fromPaper && <p className="text-[13px] text-muted-foreground">From the paper file</p>}</li>)}</ul>
            : <p className="text-sm text-muted-foreground">No review recorded yet.</p>}
        </CardBody></Card>
      </div>
      <div className="space-y-6">
        <Card><CardHeader title="Working now" /><CardBody>{driver.work ? <DescriptionList layout="rows" stacked items={[
          { label: 'Unit', value: driver.work.unit ? `${driver.work.unit}${driver.work.unitKind ? ` · ${UNIT[driver.work.unitKind] ?? driver.work.unitKind}` : ''}${driver.work.trailer ? `, trailer ${driver.work.trailer}` : ''}` : '—' },
          { label: 'Dispatcher', value: `${driver.work.dispatcher} · ${driver.work.mc}` }, { label: 'Since', value: <LocalTime iso={driver.work.startedAt} format="date" /> }]} />
          : <p className="text-sm text-muted-foreground">Not assigned to a dispatcher.</p>}</CardBody></Card>
        <Card><CardHeader title="Contact" /><CardBody><DescriptionList layout="rows" stacked items={[{ label: 'Phone', value: <a href={`tel:${driver.phone.replace(/[^\d+]/g, '')}`} className="hover:underline">{driver.phone}</a> },
          ...(driver.paperFile?.hiredOn ? [{ label: 'Hired on', value: day(driver.paperFile.hiredOn) }] : driver.clearedAt ? [{ label: 'Cleared', value: <LocalTime iso={driver.clearedAt} format="date" /> }] : [])]} /></CardBody></Card>
        <LookNote>The application, SSN, reports, test results and notes stay with Safety.{driver.withFiles ? '' : ' So do the scans.'}</LookNote>
        <p className="text-sm"><Link href="/view/safety/drivers" className="font-medium text-primary hover:underline">Back to Drivers</Link></p>
      </div>
    </div>
  </div>;
}
