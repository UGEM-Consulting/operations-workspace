import Link from 'next/link';
import { Mail, Phone, Send } from 'lucide-react';
import { requirePage } from '@/lib/auth';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { LocalTime } from '@/components/ui/local-time';
import { Table } from '@/components/ui/table';
import { TabLinks } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/workspace-ui';
import { PositionChip, workContacts } from '@/features/dispatch/glance';
import { CopyIcon } from '@/features/dispatch/glance-columns';
import { HistoryTimeline, type MemberTimeline } from '@/features/dispatch/history';
import { assists, supportName, underMc, type MemberRow } from '@/features/dispatch/types';
import { MemberFilesView, type MemberFiles } from '@/features/view/files';
import { LookNote, memberState, NotAvailable, viewRead, ViewOnlyMark } from '@/features/view/ui';
import { middayIso } from '@/lib/navigation';
export const metadata = { title: 'Dispatcher · view only' };

type ViewMember = Omit<MemberRow, 'drivers'> & {
  leftDateKnown: boolean;
  drivers: { id: string; name: string; startedAt: string; unit: string | null; unitKind: string | null; onHold: boolean; covering: { for: string; until: string } | null }[];
  covered: { id: string; name: string; cover: string; until: string }[];
  seats: { id: string; account: string | null; provider: string; status: string; shared: boolean }[];
  companyAccounts: { id: string; company: string | null; status: string; email: boolean; number: boolean; keptFor: string[] }[];
  timeline: MemberTimeline; photo: boolean; withFiles: boolean; files: MemberFiles | null;
};
const BASE = '/view/dispatch/dispatchers';
const day = (value: string) => <LocalTime iso={middayIso(value)} format="date" />;
const PROVIDER: Record<string, string> = { DAT: 'DAT', TRUCKSTOP: 'Truckstop' };
const UNIT: Record<string, string> = { SEMI: 'Semi truck', PICKUP: 'Pickup', TRAILER: 'Trailer' };
const tel = (number: string) => `tel:${number.replace(/[^\d+]/g, '')}`;

/** One work contact: icon, the value (calls, writes or opens Telegram) and its copy button. */
function ContactLine({ icon: Icon, href, text, copy, label, external }: { icon: typeof Phone; href: string; text: React.ReactNode; copy: string; label: string; external?: boolean }) {
  return <span className="flex min-w-0 items-center gap-1.5"><Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    <a href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} className="truncate text-foreground hover:underline">{text}</a><CopyIcon text={copy} label={label} /></span>;
}

/**
 * A dispatcher's page read only (ViewOnlyDispatcherScreen, ViewOnlyFilesScreen, ViewOnlyHistoryScreen, ViewOnlyPhonePageScreen):
 * where they work, work contacts, drivers, helpers, accounts they use and History; photos and documents when an administrator
 * gave them. No main button or menu.
 */
export default async function ViewDispatcherPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('viewdispatchers');
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const member = /^[0-9a-f-]{36}$/i.test(id) ? await viewRead<ViewMember>(`dispatch/members/${id}`, 'dispatcher') : null;
  if (!member) return <NotAvailable back={BASE} label="Dispatchers" />;
  const tabs = [{ key: 'overview', label: 'Overview' }, ...(member.withFiles ? [{ key: 'files', label: 'Photos and documents' }] : []), { key: 'history', label: 'History', count: member.timeline.counts.ALL }];
  const tab = tabs.some(item => item.key === query.tab) ? query.tab as string : 'overview';
  const name = `${member.firstName} ${member.lastName}`, state = memberState(member), c = workContacts(member as unknown as MemberRow), left = member.status === 'LEFT';
  const support = member.position === 'SUPPORT';
  const meta = [support ? `${supportName(member)} for ${assists(member)}` : [member.jobTitle, member.mc].filter(Boolean).join(' at '),
    member.team ? `${member.team}${member.lead ? ' · team lead' : ''}` : underMc(member.mc) ? 'Independent' : null,
    member.sinceKnown === false || !member.since ? null : <>Since {<LocalTime iso={member.since} format="date" />}</>].filter(Boolean);
  const now = [
    { label: 'MC', value: member.mc ?? 'No MC yet' },
    { label: 'Team', value: member.team ? `${member.team}${member.lead ? ' (they lead it)' : ''}` : underMc(member.mc) ? 'Independent' : '—' },
    support ? { label: 'Helps', value: assists(member) } : { label: 'Job title', value: member.jobTitle ?? 'Not set' },
    ...(member.leave ? [{ label: 'Away', value: <>On leave {day(member.leave.firstDay)} to {day(member.leave.backOn)}</> }] : []),
    ...(member.lastDay && !left ? [{ label: 'Last day', value: day(member.lastDay) }] : []),
    ...(left ? [{ label: 'Left', value: member.leftDateKnown && member.leftAt ? <LocalTime iso={member.leftAt} format="date" /> : 'Day not recorded' }] : []),
    ...(member.helpers?.length ? [{ label: 'Helped by', value: member.helpers.map(helper => `${helper.name} (${supportName(helper).toLowerCase()}${helper.wholeTeam ? ', whole team' : ''})`).join(', ') }] : []),
  ];
  const contacts = <Card><CardHeader title="Work contacts" /><CardBody><DescriptionList layout="rows" items={[
    { label: 'RingCentral', value: c.number ? <ContactLine icon={Phone} href={tel(c.number)} text={<>{c.number}{c.extension && <span className="text-muted-foreground"> ext {c.extension}</span>}</>} copy={c.extension ? `${c.number} ext ${c.extension}` : c.number} label="number" />
      : <span className="text-muted-foreground">No number recorded</span> },
    { label: 'Company email', value: c.email ? <ContactLine icon={Mail} href={`mailto:${c.email}`} text={c.email} copy={c.email} label="email" /> : <span className="text-muted-foreground">No email recorded</span> },
    { label: 'Telegram', value: c.telegram ? <ContactLine icon={Send} href={`https://t.me/${encodeURIComponent(c.telegram.slice(1))}`} text={c.telegram} copy={c.telegram} label="Telegram" external /> : <span className="text-muted-foreground">Not recorded</span> },
  ]} />{(c.emailOwner || c.numberOwner) && <p className="mt-3 text-xs text-muted-foreground">{[c.emailOwner, c.numberOwner].filter(Boolean).join(' and ')}’s, shared</p>}</CardBody></Card>;
  const drivers = !support && <Card>
    <CardHeader title="Drivers" description={member.covered.length ? 'Who they dispatch now, and who covers their drivers while they’re away.' : 'Who they dispatch now.'} />
    <Table caption="Drivers" className="mt-3 border-t border-border" rows={[...member.drivers.map(driver => ({ ...driver, cover: null as string | null })), ...member.covered.map(driver => ({ id: driver.id, name: driver.name, startedAt: null, unit: null, unitKind: null, onHold: false, covering: null, cover: `Covered by ${driver.cover} until ${new Date(middayIso(driver.until)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}` }))]}
      rowKey={row => row.id} columns={[
        { key: 'name', label: 'Driver', primary: true, cell: row => <span className="flex flex-wrap items-center gap-1.5">{row.name}{row.onHold && <Badge label="On hold" tone="danger" />}
          {row.cover && <Badge label={row.cover} tone="neutral" />}{row.covering && <Badge label={`Covering for ${row.covering.for}`} tone="info" />}</span> },
        { key: 'unit', label: 'Unit', cell: row => row.unit ? `${row.unit}${row.unitKind ? ` · ${UNIT[row.unitKind] ?? row.unitKind}` : ''}` : <span className="text-muted-foreground">—</span> },
        { key: 'since', label: 'Since', nowrap: true, muted: true, cell: row => row.startedAt ? <LocalTime iso={row.startedAt} format="date" /> : '—' },
      ]} empty={<p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">No drivers now.</p>} />
  </Card>;
  const boards = member.seats.filter(seat => seat.status !== 'ENDED');
  const accounts = <Card><CardHeader title="Load boards and other companies" description="Which accounts they use. Sign-ins stay with Dispatch and IT." /><CardBody>
    <DescriptionList layout="rows" items={[
      { label: 'Load boards', value: boards.length ? boards.map(seat => `${seat.account ?? 'Account not recorded'} (${PROVIDER[seat.provider] ?? seat.provider})${seat.status === 'SUSPENDED' ? ', suspended' : ''}${seat.shared ? ', shared' : ''}`).join('; ') : <span className="text-muted-foreground">None</span> },
      ...member.companyAccounts.map(account => ({ label: `Account at ${account.company ?? 'another company'}`, value: `${[account.email ? 'Company email' : '', account.number ? 'RingCentral number' : ''].filter(Boolean).join(' and ') || 'Recorded'}${account.status === 'CLOSED' ? ', closed' : account.status === 'KEPT_FOR_LOAD_BOARDS' ? ', kept for load boards' : ''}` })),
    ]} /></CardBody></Card>;
  return <div className="space-y-6">
    <PageHeader title={name} badge={<span className="flex flex-wrap items-center gap-2"><Badge label={state.label} tone={state.tone} /><ViewOnlyMark /></span>}
      meta={[<PositionChip key="position" row={member} />, ...meta]} />
    <TabLinks label="Dispatcher sections" value={tab} items={tabs.map(item => ({ ...item, href: `${BASE}/${id}${item.key === 'overview' ? '' : `?tab=${item.key}`}` }))} />
    {tab === 'history' ? <HistoryTimeline timeline={member.timeline} viewOnly />
      : tab === 'files' && member.files ? <MemberFilesView memberId={id} name={name} photo={member.photo} files={member.files} />
      : <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <div className="space-y-6 max-lg:order-2">{drivers}{accounts}</div>
        <div className="space-y-6 max-lg:order-1"><Card><CardHeader title="Now" /><CardBody><DescriptionList layout="rows" stacked items={now} /></CardBody></Card>{contacts}
          <LookNote>Personal details and the reasons staff wrote stay with Dispatch managers.{member.withFiles ? ' Their ID photo and signed documents are on Photos and documents, since an administrator gave you those.' : ''}</LookNote>
          <p className="text-sm"><Link href={BASE} className="font-medium text-primary hover:underline">Back to Dispatchers</Link></p></div>
      </div>}
  </div>;
}
