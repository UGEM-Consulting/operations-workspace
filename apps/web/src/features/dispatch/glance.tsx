import Link from 'next/link';
import type { ReactNode } from 'react';
import { CalendarClock, CalendarDays, CircleAlert, Clock3, Crown, FileWarning, Headset, Mail, Phone, RefreshCw, Route, Send, ShieldCheck, type LucideIcon } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { middayIso } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { CopyIcon } from './glance-columns';
import { telegramHandle } from './members-csv';
import { assists, fullName, missingDetails, supportName, type MemberRow } from './types';

// Dispatchers at a glance (section 36: GlanceTableScreen, GlanceAllTabScreen, GlancePhoneScreen, approved 2026-11-17).
// Plain components for the server page; only the copy buttons and the Columns menu run in the browser.

const POSITIONS: Record<'DISPATCHER' | 'SUPPORT' | 'UPDATER', { icon: LucideIcon; className: string }> = {
  DISPATCHER: { icon: Route, className: 'bg-position-dispatcher-background text-position-dispatcher' },
  SUPPORT: { icon: Headset, className: 'bg-position-support-background text-position-support' },
  UPDATER: { icon: RefreshCw, className: 'bg-position-updater-background text-position-updater' },
};
const positionKey = (row: Pick<MemberRow, 'position' | 'supportType'>) => row.position === 'DISPATCHER' ? 'DISPATCHER' : row.supportType === 'UPDATER' ? 'UPDATER' : 'SUPPORT';

/** Position as a coloured chip with its icon and name (colour is never the only cue); a team lead adds a crown. */
export function PositionChip({ row }: { row: Pick<MemberRow, 'position' | 'supportType' | 'lead'> }) {
  const key = positionKey(row), { icon: Icon, className } = POSITIONS[key];
  return <span className="inline-flex items-center gap-1.5">
    <span className={cn('inline-flex h-5 items-center gap-1 rounded-md pr-1.5 pl-1 text-xs leading-5 font-medium whitespace-nowrap', className)}><Icon aria-hidden="true" className="size-3.5" />{key === 'DISPATCHER' ? 'Dispatcher' : supportName(row)}</span>
    {row.lead && <span title="Team lead" role="img" aria-label="Team lead" className="text-muted-foreground"><Crown aria-hidden="true" className="size-3.5" /></span>}
  </span>;
}

/** Name, position chip, who a support helps, and the name they used before. Links to their page (base: Dispatch's, or the view-only one). */
export function NameCell({ row, children, base = '/dispatch/dispatchers' }: { row: MemberRow; children?: ReactNode; base?: string }) {
  const name = fullName(row);
  return <span className="flex min-w-0 items-start gap-2.5">
    <Avatar name={name} size="sm" />
    <span className="grid min-w-0 gap-0.5">
      <Link href={`${base}/${row.id}`} className="truncate text-sm font-medium text-foreground hover:underline focus-visible:outline-2">{name}</Link>
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5"><PositionChip row={row} />{row.position === 'SUPPORT' && <span className="text-[13px] leading-[18px] text-muted-foreground">for {assists(row)}</span>}</span>
      {row.otherName && <span className="text-[13px] leading-[18px] text-muted-foreground">Was {row.otherName}</span>}
      {children}
    </span>
  </span>;
}

/** Someone else's email or number they use, or null. */
const sharedOf = (row: MemberRow, kind: 'EMAIL' | 'RINGCENTRAL') => row.shared?.find(item => item.kind === kind) ?? null;
/** The email and number shown: their own, else the one they use of someone else's (marked whose). */
export function workContacts(row: MemberRow) {
  const email = sharedOf(row, 'EMAIL'), number = sharedOf(row, 'RINGCENTRAL');
  return { email: row.companyEmail ?? email?.value ?? null, emailOwner: row.companyEmail ? null : email?.owner ?? null,
    number: row.ringCentralNumber ?? number?.value ?? null, numberOwner: row.ringCentralNumber ? null : number?.owner ?? null,
    extension: row.ringCentralExtension ?? null, telegram: telegramHandle(row.telegram) };
}
const tel = (number: string) => `tel:${number.replace(/[^\d+]/g, '')}`;
const line = 'flex min-w-0 items-center gap-1.5 whitespace-nowrap';
const lineIcon = 'size-3.5 shrink-0 text-muted-foreground';

/** RingCentral number with extension (calls), company email and Telegram, each copyable; muted for someone who left. */
export function ContactCell({ row }: { row: MemberRow }) {
  const c = workContacts(row), left = row.status === 'LEFT';
  const owners = [...new Set([c.emailOwner, c.numberOwner].filter(Boolean))];
  return <div className={cn('grid gap-0.5 text-[13px] leading-5', left && 'text-muted-foreground')}>
    {c.number ? <span className={line}><Phone aria-hidden="true" className={lineIcon} />
      {left ? <span className="font-mono">{c.number}</span> : <a href={tel(c.number)} className="font-mono text-foreground hover:underline">{c.number}</a>}
      {c.extension && <span className="text-muted-foreground">ext {c.extension}</span>}{!left && <CopyIcon text={c.extension ? `${c.number} ext ${c.extension}` : c.number} label="number" />}</span>
      : <span className={cn(line, 'text-muted-foreground')}><Phone aria-hidden="true" className={lineIcon} />No number recorded</span>}
    {c.email ? <span className={line}><Mail aria-hidden="true" className={lineIcon} />
      {left ? <span className="truncate">{c.email}</span> : <a href={`mailto:${c.email}`} title={c.email} className="truncate text-foreground hover:underline">{c.email}</a>}{!left && <CopyIcon text={c.email} label="email" />}</span>
      : <span className={cn(line, 'text-muted-foreground')}><Mail aria-hidden="true" className={lineIcon} />No email recorded</span>}
    {owners.length > 0 && <span className="pl-5 text-xs leading-4 text-muted-foreground">{owners.join(' and ')}’s, shared</span>}
    {c.telegram && !left && <span className={line}><Send aria-hidden="true" className={lineIcon} /><a href={`https://t.me/${encodeURIComponent(c.telegram.slice(1))}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">{c.telegram}</a><CopyIcon text={c.telegram} label="Telegram" /></span>}
    {left && row.accountsClosed && <span className="text-xs leading-4">Closed by IT</span>}
  </div>;
}

/** Their supports and updaters; on a lead's row, those assisting the whole team too. */
export function HelpersCell({ row, base = '/dispatch/dispatchers' }: { row: MemberRow; base?: string }) {
  if (!row.helpers?.length) return <span className="text-muted-foreground">—</span>;
  return <span className="grid gap-0.5 text-[13px] leading-[18px]">{row.helpers.map(helper => <span key={helper.id}>
    <Link href={`${base}/${helper.id}`} className="text-foreground hover:underline">{helper.name}</Link>
    <span className="text-muted-foreground"> · {supportName(helper).toLowerCase()}{helper.wholeTeam ? ', whole team' : ''}</span></span>)}</span>;
}

/** DAT and Truckstop, from their open seats. */
export function LoadBoardsCell({ row }: { row: MemberRow }) {
  if (!row.loadBoards?.length) return <span className="text-muted-foreground">—</span>;
  return <span className="flex flex-wrap gap-1">{row.loadBoards.map(board => <span key={board} className="rounded-full bg-muted px-2 text-xs leading-5 text-muted-foreground">{board === 'TRUCKSTOP' ? 'Truckstop' : board}</span>)}</span>;
}

const shortDay = (day: string) => new Date(middayIso(day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const FLAG_TONES = { neutral: 'bg-muted text-muted-foreground', warning: 'bg-warning-background text-warning' };
function Flag({ icon: Icon, label, tone = 'neutral' }: { icon: LucideIcon; label: string; tone?: keyof typeof FLAG_TONES }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 text-xs leading-5 font-medium whitespace-nowrap', FLAG_TONES[tone])}><Icon aria-hidden="true" className="size-3" />{label}</span>;
}
/** What needs doing about someone, under their status: their last day, their return, IT setting them up, paperwork, missing details. */
export function statusFlags(row: MemberRow) {
  const flags: ReactNode[] = [];
  if (row.lastDay && row.status !== 'LEFT') flags.push(<Flag key="last" icon={CalendarClock} label={`Last day ${shortDay(row.lastDay)}`} tone="warning" />);
  if (row.leave?.started) flags.push(<Flag key="back" icon={CalendarDays} label={`Back ${shortDay(row.leave.backOn)}`} />);
  if (row.status === 'ONBOARDING') flags.push(<Flag key="it" icon={Clock3} label="IT setting up" />);
  if (row.addedByHand && row.paperworkAccepted === false && row.status !== 'LEFT') flags.push(<Flag key="paper" icon={FileWarning} label="Paperwork waiting" />);
  if (missingDetails(row)) flags.push(<Flag key="missing" icon={CircleAlert} label="Missing details" />);
  if (row.status === 'LEFT' && row.accountsClosed) flags.push(<Flag key="closed" icon={ShieldCheck} label="Accounts closed" />);
  return flags;
}

/**
 * The phone card's extra lines (GlancePhoneScreen): where they work, drivers, helpers and load boards, and Call, Email and
 * Telegram buttons; a missing one is dashed so it's clear what to record.
 */
export function PhoneDetails({ row, where }: { row: MemberRow; where: string }) {
  const c = workContacts(row), left = row.status === 'LEFT';
  const facts = [row.position === 'DISPATCHER' && row.drivers !== undefined ? ['Drivers', String(row.drivers)] : null,
    row.helpers?.length ? ['Helped by', row.helpers.map(helper => helper.name).join(', ')] : null,
    row.loadBoards?.length ? ['Load boards', row.loadBoards.map(board => board === 'TRUCKSTOP' ? 'Truckstop' : board).join(', ')] : null].filter(Boolean) as [string, string][];
  const owners = [...new Set([c.emailOwner, c.numberOwner].filter(Boolean))];
  const action = 'flex flex-col items-center gap-0.5 rounded-lg border border-border px-1 py-2 text-xs leading-4 text-foreground', off = 'border-dashed text-muted-foreground';
  return <span className="mt-1 grid gap-2">
    {where && <span className="text-[13px] leading-[18px] text-muted-foreground">{where}</span>}
    {(facts.length > 0 || owners.length > 0) && <span className="flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] leading-[18px] text-muted-foreground">
      {facts.map(([label, value]) => <span key={label}>{label} <b className="font-medium text-foreground">{value}</b></span>)}
      {owners.length > 0 && <span>{c.email && c.emailOwner && c.number && c.numberOwner ? 'Email and number are' : c.emailOwner ? 'Email is' : 'Number is'} {owners.join(' and ')}’s, shared</span>}</span>}
    {!left && <span className="grid grid-cols-3 gap-2">
      {c.number ? <a href={tel(c.number)} className={action}><Phone aria-hidden="true" className="size-[18px] text-primary" />Call{c.extension ? ` · ext ${c.extension}` : ''}</a> : <span className={cn(action, off)}><Phone aria-hidden="true" className="size-[18px]" />No number</span>}
      {c.email ? <a href={`mailto:${c.email}`} className={action}><Mail aria-hidden="true" className="size-[18px] text-primary" />Email</a> : <span className={cn(action, off)}><Mail aria-hidden="true" className="size-[18px]" />No email</span>}
      {c.telegram ? <a href={`https://t.me/${encodeURIComponent(c.telegram.slice(1))}`} target="_blank" rel="noreferrer" className={action}><Send aria-hidden="true" className="size-[18px] text-primary" />Telegram</a> : <span className={cn(action, off)}><Send aria-hidden="true" className="size-[18px]" />No Telegram</span>}
    </span>}
  </span>;
}
