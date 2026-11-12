import Link from 'next/link';
import { Send } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { FilterBar } from '@/components/ui/filter-bar';
import { PageHeader, StatCard } from '@/components/workspace-ui';
import { queueHref } from '@/lib/navigation';
import { ExpiringRenewal } from './expiring-renewal';
import { reminderOutcome } from './reminder-words';
import { permitLabels, unitKinds, type PermitKind, type UnitKind } from './units-types';
import { documentLabels, ownerDocumentLabels, type DocumentKind, type RenewalKind, type RenewalLink, type RenewalScan } from './types';

export interface ExpiringItem { documentId: string; driverId: string; kind: string; expiresOn: string; firstName: string; lastName: string; status: string; truck?: string | null; owner: { id?: string; name: string } | null; expired: boolean;
  // From an API with renewals: the driver's version and email, and, for an approved or cleared driver's license or medical card, where its renewal stands.
  version?: number; email?: string | null; renewal?: { link: RenewalLink | null; scan: RenewalScan | null } | null;
  // From an API with expiration reminders: how the driver was last reminded about this document (licenses and medical cards only).
  reminded?: { channel: 'EMAIL' | 'TELEGRAM'; status: string; failureCode?: string | null; at: string } | null }
export interface DueReview { driverId: string; firstName: string; lastName: string; owner: string | null; lastReviewedOn: string | null; dueOn: string; notQualified: boolean; overdue: boolean }
export interface DueTest { driverId: string; firstName: string; lastName: string; kind: 'DRUG' | 'ALCOHOL'; result: string; testedOn: string; owner: string | null }
export interface DueIncident { incidentId: string; driverId: string; firstName: string; lastName: string; kind: 'ACCIDENT' | 'VIOLATION' | 'INSPECTION'; occurredOn: string; owner: string | null }
export interface DueList { today: string; warningDays: number; items: DueReview[]; tests?: DueTest[]; incidents?: DueIncident[] }
/** A renewal scan a driver sent that waits for a check (section 33), with the checked document it would replace. */
export interface ScanToCheck { id: string; kind: RenewalKind; version: number; pageCount: number; createdAt: string; driverId: string; firstName: string; lastName: string; driverVersion: number; email: string | null;
  owner: { id?: string; name: string } | null; replacesExpiresOn: string | null;
  // The document's open renewal link, so Not readable warns that a new link stops it; absent from an older API.
  link?: RenewalLink | null }
export interface UnitDue { unitId: string; number: string; kind: string; document: string; dueOn: string; expired: boolean; responsibleId: string | null; responsible: string | null; owner: string | null; driverNow: string | null }
export interface ExpiringList { today: string; warningDays: number; items: ExpiringItem[]; scans?: ScanToCheck[]; units?: { items: UnitDue[]; yearEnd: { on: string; due: number; units: number } } }

const day = (value: string) => <LocalTime iso={`${value}T12:00:00Z`} format="date" />;

// A calendar day (YYYY-MM-DD) plus some days.
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const EXPIRING_DEFAULTS: Record<string, string> = { view: 'all', search: '' };

/**
 * Safety › Expiring documents (designed as ExpiringDocumentsScreen): verified scans that have expired or expire soon,
 * soonest first, with counts and a My drivers view for owners. An expired license or medical card puts the driver on hold.
 * Reminders go out by themselves (ReminderStaffScreen): `telegram` is the viewer's own connection, when they get Safety
 * reminders, so someone not connected is asked to connect (ReminderStaffNotConnectedScreen). Renewal scans drivers sent wait
 * at the top until someone checks them (ScansToCheckScreen), and an empty My drivers says so about your drivers only
 * (ExpiringMineEmptyScreen). An older API sends no scans.
 */
export function ExpiringDocuments({ data, reviews, meId, screener, filters, telegram }: { data: ExpiringList; reviews: DueList; meId: string; screener: boolean; filters: Record<string, string>;
  telegram?: { available: boolean; connected: boolean; email: string } }) {
  const mine = data.items.filter(item => item.owner?.id === meId), soon = addDays(data.today, 30);
  const query = (filters.search ?? '').toLowerCase();
  const shown = (filters.view === 'mine' ? mine : data.items).filter(item => `${item.firstName} ${item.lastName}`.toLowerCase().includes(query));
  const href = (view: string) => queueHref('/safety/expiring', filters, { view });
  // Safety leads, the Safety manager, administrators and the driver's owner renew (the API decides).
  const renewable = (item: ExpiringItem) => !!item.renewal && item.version !== undefined && (screener || item.owner?.id === meId);
  const scans = data.scans ?? [];
  const checkable = (scan: ScanToCheck) => screener || scan.owner?.id === meId;
  const name = (row: { firstName: string; lastName: string }) => `${row.firstName} ${row.lastName}`.trim();
  const checkIt = (scan: ScanToCheck) => <ExpiringRenewal kind={scan.kind} scan={{ id: scan.id, version: scan.version, pageCount: scan.pageCount, createdAt: scan.createdAt, unreadable: false }} link={scan.link ?? null} expired={false}
    name={name(scan)} driver={{ id: scan.driverId, firstName: scan.firstName, email: scan.email, version: scan.driverVersion }} />;
  // My drivers with nothing of theirs: say so, and offer the rest, rather than "Nothing is expiring" while All has rows.
  const others = data.items.length - mine.length;
  const empty = filters.view === 'mine' && !query && others > 0
    ? <EmptyState title="Nothing expiring for your drivers" description={`None of the drivers you’re the Safety Manager for has a document that expired or expires within ${data.warningDays} days. ${others} other ${others === 1 ? 'driver has' : 'drivers have'} one.`}
      action={<Button variant="outline" asChild><Link href={href('all')}>Show all {others}</Link></Button>} />
    : <EmptyState title="Nothing is expiring" description="No verified document has expired or expires soon." />;
  // A scan waiting for its check is checked from Renewal scans to check (an older API sends no scans, so then from its row),
  // so one scan never has two Check it buttons.
  const checkedAbove = (item: ExpiringItem) => data.scans !== undefined && !!item.renewal?.scan && !item.renewal.scan.unreadable;
  const renewalState = (item: ExpiringItem) => {
    // A scan to check first, then a link that is out (also after Not readable), then an unreadable scan.
    const scan = item.renewal?.scan, link = item.renewal?.link;
    if (scan && !scan.unreadable) return <Badge label={checkedAbove(item) ? 'Scan to check above' : 'Waiting for your check'} tone="warning" />;
    if (link) return link.expired ? <Badge label="Link expired" tone="neutral" /> : <span className="inline-flex flex-wrap items-center gap-1.5"><Badge label="Link sent" tone="info" /><LocalTime iso={link.createdAt} format="date" className="text-[13px] text-muted-foreground" /></span>;
    if (scan) return <Badge label="Not readable" tone="danger" />;
    return '—';
  };
  return <div className="space-y-6">
    <PageHeader title="Expiring documents" description={`Licenses, medical cards and work permits that have expired or expire within ${data.warningDays} days, and yearly driver reviews that are due. Reminders go out by themselves; open the driver to act.`} />
    {telegram?.available && !telegram.connected && <Alert tone="info" title="Get your reminders on Telegram"
      action={<Button size="sm" asChild><Link href="/account/security"><Send aria-hidden="true" className="size-4" />Connect my Telegram</Link></Button>}>
      <p>Until you connect, reminders about your drivers’ documents go to {telegram.email}.</p></Alert>}
    {scans.length > 0 && <Alert tone="warning" title={`Renewal scans to check: ${scans.length}`} action={scans.length === 1 && checkable(scans[0]) ? checkIt(scans[0]) : undefined}>
      <p>{scans.length === 1 ? `${name(scans[0])} sent a new ${documentLabels[scans[0].kind].toLowerCase()} through the renewal link. Type the date printed on it to make it count.`
        : 'Drivers sent renewed documents through renewal links. Type the date printed on each one to make it count.'}</p></Alert>}
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard label="Expired" value={data.items.filter(item => item.expired).length} detail="Renew or replace them now" href={href('all')} tone="danger" />
      <StatCard label="Within 30 days" value={data.items.filter(item => !item.expired && item.expiresOn <= soon).length} detail="Contact the driver now" href={href('all')} tone="warning" />
      <StatCard label={`Within ${data.warningDays} days`} value={data.items.filter(item => !item.expired && item.expiresOn > soon).length} detail="Coming up" href={href('all')} tone="neutral" />
      <StatCard label="Yours" value={mine.length} detail="Drivers you’re the Safety Manager for" href={href('mine')} tone="info" />
    </div>
    {scans.length > 0 && <Card>
      <CardHeader title="Renewal scans to check" description="Sent by drivers through a renewal link. Until someone checks it, the earlier document still counts." />
      <Table<ScanToCheck> caption="Renewal scans to check" className="border-t border-border" rows={scans} rowKey={scan => scan.id}
        columns={[
          { key: 'driver', label: 'Driver', primary: true, cell: scan => <Link className="font-medium underline" href={`/safety/drivers/${scan.driverId}`}>{name(scan)}</Link> },
          { key: 'document', label: 'Document', cell: scan => `${documentLabels[scan.kind]} · ${scan.pageCount} ${scan.pageCount === 1 ? 'page' : 'pages'}` },
          { key: 'sent', label: 'Sent', nowrap: true, cell: scan => <LocalTime iso={scan.createdAt} /> },
          { key: 'replaces', label: 'Document it replaces', hideBelow: 'lg', cell: scan => scan.replacesExpiresOn ? <>Valid until {day(scan.replacesExpiresOn)}</> : '—' },
          { key: 'owner', label: 'Safety Manager', hideBelow: 'lg', cell: scan => scan.owner?.name ?? '—' },
          { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: scan => checkable(scan) ? checkIt(scan) : null },
        ]} />
    </Card>}
    <Card>
      <FilterBar path="/safety/expiring" filters={filters} defaults={EXPIRING_DEFAULTS} statusKey="view" searchLabel="Search driver" statuses={[{ key: 'mine', label: 'My drivers', count: mine.length }, { key: 'all', label: 'All', count: data.items.length }]} />
      <Table<ExpiringItem> caption="Documents that have expired or expire soon" className="border-t border-border" rows={shown} rowKey={item => item.documentId}
        empty={empty}
        columns={[
          { key: 'driver', label: 'Driver', primary: true, cell: item => <Link className="font-medium underline" href={`/safety/drivers/${item.driverId}`}>{`${item.firstName} ${item.lastName}`.trim()}</Link> },
          { key: 'document', label: 'Document', cell: item => (documentLabels[item.kind as DocumentKind] ?? ownerDocumentLabels[item.kind as keyof typeof ownerDocumentLabels] ?? 'Document') + (item.truck ? ` · unit ${item.truck}` : '') },
          { key: 'expires', label: 'Expires', nowrap: true, cell: item => <>{day(item.expiresOn)} <Badge label={item.expired ? 'Expired' : 'Expiring'} tone={item.expired ? 'danger' : 'warning'} /></> },
          { key: 'renewal', label: 'Renewal', hideBelow: 'md', cell: renewalState },
          // Drivers are reminded about their license and medical card only; the rest go to Safety (ReminderStaffScreen).
          ...(data.items.some(item => item.reminded !== undefined) ? [{ key: 'reminded', label: 'Driver reminded', hideBelow: 'lg' as const, cell: (item: ExpiringItem) => item.reminded
            ? <>{reminderOutcome({ ...item.reminded, failureCode: item.reminded.failureCode ?? null })} · <LocalTime iso={item.reminded.at} format="date" /></>
            : item.truck || !['LICENSE', 'MEDICAL_CARD'].includes(item.kind) ? <span className="text-muted-foreground">Staff only</span> : '—' }] : []),
          { key: 'owner', label: 'Safety Manager', hideBelow: 'lg', cell: item => item.owner?.name ?? '—' },
          { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: item => renewable(item) && !checkedAbove(item) ? <ExpiringRenewal kind={item.kind as RenewalKind} scan={item.renewal?.scan ?? null} link={item.renewal?.link ?? null} expired={item.expired}
            name={`${item.firstName} ${item.lastName}`.trim()} driver={{ id: item.driverId, firstName: item.firstName, email: item.email ?? null, version: item.version! }} /> : null },
        ]} />
    </Card>
    {/* Dec 31 permits are gathered by unit on their own page (PermitsYearEndScreen), so they don't fill this one. */}
    {data.units && data.units.yearEnd.due > 0 && data.today.slice(5) >= '10-01' && <Alert tone="info" title={`Permits for ${Number(data.units.yearEnd.on.slice(0, 4)) + 1}: ${data.units.yearEnd.due} to renew by Dec 31`}
      action={<Button size="sm" variant="outline" asChild><Link href="/safety/expiring/permits">Open year-end permits</Link></Button>}>
      <p>They’re gathered by unit so they don’t fill this page.</p></Alert>}
    {data.units && <UnitsDue units={data.units} today={data.today} meId={meId} />}
    <Card>
      <Table<DueReview> caption="Yearly reviews that are due" rows={reviews.items} rowKey={item => item.driverId}
        empty={<EmptyState title="No yearly review is due" description={`No cleared driver is due for a yearly review within ${reviews.warningDays} days.`} />}
        columns={[
          { key: 'driver', label: 'Yearly review', primary: true, cell: item => <Link className="font-medium underline" href={`/safety/drivers/${item.driverId}`}>{`${item.firstName} ${item.lastName}`.trim()}</Link> },
          { key: 'due', label: 'Due', cell: item => <>{day(item.dueOn)} <Badge label={item.notQualified ? 'Not qualified' : item.overdue ? 'Overdue' : 'Due soon'} tone={item.notQualified || item.overdue ? 'danger' : 'warning'} /></> },
          { key: 'last', label: 'Last review', hideBelow: 'md', cell: item => item.lastReviewedOn ? day(item.lastReviewedOn) : 'None yet' },
          { key: 'owner', label: 'Safety Manager', hideBelow: 'md', cell: item => item.owner ?? '—' },
        ]} />
    </Card>
    {reviews.tests && reviews.tests.length > 0 && <Card>
      <Table<DueTest> caption="Test results that need follow-up" rows={reviews.tests} rowKey={item => `${item.driverId}-${item.kind}`}
        columns={[
          { key: 'driver', label: 'Test follow-up', primary: true, cell: item => <Link className="font-medium underline" href={`/safety/drivers/${item.driverId}`}>{`${item.firstName} ${item.lastName}`.trim()}</Link> },
          { key: 'test', label: 'Latest result', cell: item => <>{item.kind === 'DRUG' ? 'Drug' : 'Alcohol'} · {day(item.testedOn)} <Badge label={item.result === 'REFUSED' ? 'Refused' : 'Not negative'} tone="danger" /></> },
          { key: 'owner', label: 'Safety Manager', hideBelow: 'md', cell: item => item.owner ?? '—' },
        ]} />
    </Card>}
    {reviews.incidents && reviews.incidents.length > 0 && <Card>
      <Table<DueIncident> caption="Incidents that need a decision" rows={reviews.incidents} rowKey={item => item.incidentId}
        columns={[
          { key: 'driver', label: 'Open incidents', primary: true, cell: item => <Link className="font-medium underline" href={`/safety/drivers/${item.driverId}`}>{`${item.firstName} ${item.lastName}`.trim()}</Link> },
          { key: 'what', label: 'What', cell: item => <>{item.kind === 'ACCIDENT' ? 'Accident' : 'Violation'} · {day(item.occurredOn)} <Badge label={item.kind === 'ACCIDENT' ? 'Preventability open' : 'Pending'} tone="warning" /></> },
          { key: 'owner', label: 'Safety Manager', hideBelow: 'md', cell: item => item.owner ?? '—' },
        ]} />
    </Card>}
  </div>;
}

const unitDocument = (document: string) => document === 'REGISTRATION' ? 'Registration' : document === 'INSPECTION' ? 'Yearly inspection'
  : document.startsWith('PERMIT:') ? permitLabels[document.slice(7) as PermitKind] ?? 'Permit' : 'Document';

/** Units with a registration, yearly inspection or permit due (ExpiringUnitsScreen). Reminders go to the unit's responsible Safety Manager. */
function UnitsDue({ units, today, meId }: { units: NonNullable<ExpiringList['units']>; today: string; meId: string }) {
  const mine = units.items.filter(item => item.responsibleId === meId).length;
  return <Card>
    <CardHeader title="Units" description={`Registrations, yearly inspections and permits that have expired or come due soon.${mine ? ` ${mine} on units you’re responsible for.` : ''}`}
      actions={<Button size="sm" variant="outline" asChild><Link href="/safety/units">All units</Link></Button>} />
    <Table<UnitDue> caption="Unit dates due" className="mt-3 border-t border-border" rows={units.items} rowKey={item => `${item.unitId}-${item.document}`}
      empty={<EmptyState compact title="Nothing due on units" description="No registration, inspection or permit has expired or comes due soon." />}
      columns={[
        { key: 'unit', label: 'Unit', primary: true, cell: item => <Link className="font-medium underline" href={`/safety/units/${item.unitId}`}>{item.number}</Link> },
        { key: 'what', label: 'What', cell: item => `${unitDocument(item.document)} · ${unitKinds[item.kind as UnitKind] ?? 'Unit'}` },
        { key: 'due', label: 'Due', nowrap: true, cell: item => <>{day(item.dueOn)} <Badge label={item.expired ? 'Expired' : item.dueOn === today ? 'Today' : 'Coming up'} tone={item.expired ? 'danger' : 'warning'} /></> },
        { key: 'driver', label: 'Driver now', hideBelow: 'lg', cell: item => item.driverNow ?? '—' },
        { key: 'responsible', label: 'Responsible', hideBelow: 'md', cell: item => item.responsible ?? '—' },
      ]} />
  </Card>;
}
