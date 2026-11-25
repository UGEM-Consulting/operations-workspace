'use client';
import { useMemo, useState } from 'react';
import { Building2, Calendar, CalendarClock, Crown, Eye, FileText, Headset, Image, KeyRound, Layers, Link2, LogOut, Mail, Monitor, PenLine, Phone, RefreshCw, Route, ShieldCheck, TrendingUp, Truck, UserCheck, UserPlus, Users, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Timeline } from '@/components/ui/timeline';
import { cn } from '@/lib/utils';

/**
 * The complete History (section 38: HistoryTimelineScreen, HistoryAccountsFilterScreen, HistoryViewsScreen, HistoryPhoneScreen;
 * approved 2026-11-19). The API words every entry and gives its filter; this shows them newest first by month, 50 at a time.
 */
export type HistoryCategory = 'WORK' | 'ACCOUNTS' | 'AWAY' | 'DETAILS' | 'IT' | 'VIEWS';
export interface HistoryEntry { id: string; at: string; category: HistoryCategory; icon: string; title: string; by: string | null; body: string | null; dateOnly?: boolean }
export interface MemberTimeline { entries: HistoryEntry[]; counts: Record<'ALL' | HistoryCategory, number> }

const ICONS: Record<string, LucideIcon> = { route: Route, crown: Crown, headset: Headset, 'refresh-cw': RefreshCw, 'trending-up': TrendingUp, truck: Truck, 'pen-line': PenLine, 'user-plus': UserPlus, 'user-check': UserCheck,
  phone: Phone, mail: Mail, 'building-2': Building2, layers: Layers, users: Users, calendar: Calendar, 'calendar-clock': CalendarClock, 'log-out': LogOut, 'shield-check': ShieldCheck, monitor: Monitor, 'key-round': KeyRound,
  'file-text': FileText, image: Image, eye: Eye, link: Link2 };
const FILTERS: { key: 'ALL' | Exclude<HistoryCategory, 'VIEWS'>; label: string }[] = [{ key: 'ALL', label: 'All' }, { key: 'WORK', label: 'Work' }, { key: 'ACCOUNTS', label: 'Accounts' }, { key: 'AWAY', label: 'Leave and leaving' }, { key: 'DETAILS', label: 'Details' }, { key: 'IT', label: 'IT' }];
const PAGE = 50;
const monthOf = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' });

/** viewOnly (section 39, ViewOnlyHistoryScreen): no IT filter or file views, and a line saying where reasons and notes stay. */
export function HistoryTimeline({ timeline, viewOnly = false }: { timeline: MemberTimeline; viewOnly?: boolean }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('ALL'), [views, setViews] = useState(false), [shown, setShown] = useState(PAGE);
  const matching = useMemo(() => timeline.entries.filter(entry => entry.category === 'VIEWS' ? views && (filter === 'ALL' || filter === 'DETAILS') : filter === 'ALL' || entry.category === filter), [timeline.entries, filter, views]);
  const page = matching.slice(0, shown);
  // Months in order of the entries, so a page that ends mid-month just carries on after Show older.
  const months = page.reduce<{ month: string; entries: HistoryEntry[] }[]>((groups, entry) => {
    const month = monthOf(entry.at), last = groups[groups.length - 1];
    if (last?.month === month) last.entries.push(entry); else groups.push({ month, entries: [entry] });
    return groups;
  }, []);
  const choose = (key: typeof filter) => { setFilter(key); setShown(PAGE); };
  const filters = viewOnly ? FILTERS.filter(item => item.key !== 'IT') : FILTERS;
  return <Card><CardHeader title="History" description={viewOnly ? 'Every change and who made it. Reasons and notes staff wrote stay with Dispatch managers.' : 'Every change and who made it. Emails, phone numbers and sign-ins stay on Overview.'} />
    <CardBody className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Show" className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md bg-muted p-[3px] [scrollbar-width:none]">
          {filters.map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => choose(item.key)} data-active={filter === item.key}
            className="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-sm px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground data-[active=true]:bg-card data-[active=true]:text-foreground data-[active=true]:shadow-xs">
            {item.label}<span className="min-w-5 text-center text-xs font-semibold tabular-nums">{(timeline.counts[item.key] ?? 0) + (views && (item.key === 'ALL' || item.key === 'DETAILS') ? timeline.counts.VIEWS ?? 0 : 0)}</span></button>)}
        </div>
        {!viewOnly && <Checkbox label="Show who opened files" checked={views} onChange={event => { setViews(event.target.checked); setShown(PAGE); }} description={views ? undefined : timeline.counts.VIEWS ? `${timeline.counts.VIEWS} recorded` : undefined} />}
      </div>
      {!matching.length ? <p className="text-sm text-muted-foreground">{timeline.entries.length ? 'Nothing here for this filter.' : 'Nothing recorded yet.'}</p>
        : months.map(group => <section key={group.month} aria-label={group.month}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.month}</h3>
          <Timeline items={group.entries.map(entry => { const Icon = ICONS[entry.icon] ?? PenLine; return { id: entry.id, icon: <Icon aria-hidden="true" />, title: entry.title,
            meta: <>{entry.by ? `${entry.by} · ` : ''}<LocalTime iso={entry.at} format={entry.dateOnly ? 'date' : 'datetime'} /></>, body: entry.body ?? undefined }; })} />
        </section>)}
      {matching.length > shown && <div className="flex justify-center"><Button variant="outline" className={cn('max-sm:w-full')} onClick={() => setShown(count => count + PAGE)}>Show older ({matching.length - shown})</Button></div>}
    </CardBody>
  </Card>;
}
