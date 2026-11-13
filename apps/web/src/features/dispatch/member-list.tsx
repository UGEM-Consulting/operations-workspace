'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChevronDown, Download, SlidersHorizontal, X } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { inputClass, RadioGroup, Select } from '@/components/ui/field';
import { errorMessage, mutate, readApi } from '@/lib/client-api';
import { MEMBER_DEFAULTS } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { FILTER_KEYS, membersHref, type FilterKey } from './member-filters';
import { archived, chipValue, DRIVERS, FILTER_LABELS as LABELS, POSITIONS, SOURCES } from './member-view.ts';
import { membersCsv, type ExportRow } from './members-csv';
import type { MemberOptions } from './types';

const teamChoices = (options: MemberOptions, mcId: string) => [{ value: 'NONE', label: 'Independent (no team)' },
  ...options.teams.filter(team => !mcId || team.mcId === mcId).map(team => ({ value: team.id, label: archived(team) }))];
const smallSelect = cn(inputClass, 'mt-0 w-full cursor-pointer appearance-none pr-8');

function FilterSelect({ label, value, all, options, onChange, className }: { label: string; value: string; all: string; options: { value: string; label: string }[]; onChange: (value: string) => void; className?: string }) {
  return <div className={cn('relative flex items-center', className)}>
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)} className={smallSelect}>
      <option value="">{all}</option>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground" />
  </div>;
}

/**
 * The filters, chips and Export of Dispatch › Dispatchers (designed as DispatchersFiltersScreen and its phone versions,
 * approved 2026-11-13). From 768px the five main filters sit in a row and More filters holds Source and Drivers; on phones
 * one Filters button opens every filter in a dialog. Each change reloads the page from the server.
 */
export function MemberFilters({ filters, options, total, view }: { filters: Record<string, string>; options: MemberOptions; total: number; view: string }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'all' | 'more' | null>(null);
  const go = (changes: Record<string, string>) => router.push(membersHref(filters, changes));
  const chosen = FILTER_KEYS.filter(key => filters[key]);
  const more = (['source', 'drivers', 'loadBoardAccountId'] as const).filter(key => filters[key]).length;
  return <>
    <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2 px-4 pb-3 sm:px-5">
      <div className="contents max-md:hidden">
        <FilterSelect label="MC" all="All MCs" value={filters.mcId} className="w-48" onChange={mcId => go({ mcId, teamId: '' })} options={options.mcs.map(mc => ({ value: mc.id, label: archived(mc) }))} />
        <FilterSelect label="Team" all="All teams" value={filters.teamId} className="w-40" onChange={teamId => go({ teamId })} options={teamChoices(options, filters.mcId)} />
        <FilterSelect label="Team lead" all="All team leads" value={filters.leadId} className="w-40" onChange={leadId => go({ leadId })} options={options.leads.map(lead => ({ value: lead.id, label: lead.name }))} />
        <FilterSelect label="Position" all="All positions" value={filters.position} className="w-36" onChange={position => go({ position })} options={POSITIONS} />
        <FilterSelect label="Job title" all="All job titles" value={filters.jobTitleId} className="w-40" onChange={jobTitleId => go({ jobTitleId })} options={options.jobTitles.map(title => ({ value: title.id, label: archived(title) }))} />
        <Button variant="outline" size="sm" onClick={() => setDialog('more')}><SlidersHorizontal aria-hidden="true" />More filters{more > 0 && <FilterCount count={more} />}</Button>
      </div>
      <Button variant="outline" size="sm" className="md:hidden" onClick={() => setDialog('all')}><SlidersHorizontal aria-hidden="true" />Filters{chosen.length > 0 && <FilterCount count={chosen.length} />}</Button>
      <span className="flex-1 max-md:hidden" />
      <ExportButton filters={filters} total={total} view={view} />
    </div>
    {chosen.length > 0 && <div className="flex flex-wrap items-center gap-2 px-4 pb-3 sm:px-5">
      {chosen.map(key => <span key={key} className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-muted pl-2.5 pr-1 text-[13px]">
        {LABELS[key]}: <strong className="font-semibold">{chipValue(key, filters[key], options)}</strong>
        <button type="button" aria-label={`Remove ${LABELS[key]} filter`} onClick={() => go(key === 'mcId' ? { mcId: '', teamId: '' } : { [key]: '' })} className="inline-grid size-5.5 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"><X aria-hidden="true" className="size-3.5" /></button>
      </span>)}
      <Button variant="ghost" size="sm" onClick={() => go(Object.fromEntries(FILTER_KEYS.map(key => [key, ''])))}>Clear all</Button>
    </div>}
    {dialog && <FiltersDialog all={dialog === 'all'} filters={filters} options={options} onClose={() => setDialog(null)} onApply={changes => { setDialog(null); go(changes); }} />}
  </>;
}
const FilterCount = ({ count }: { count: number }) => <span className="ml-0.5 inline-grid min-w-5 place-items-center rounded-full bg-muted px-1.5 text-xs font-semibold tabular-nums">{count}</span>;

/** How many people on this tab a query would show, counts only (an older API without only=counts answers 400: null). */
const matchTotal = (tab: string, query: Record<string, string>) => readApi<{ total?: unknown }>(`dispatch/members?${new URLSearchParams({ status: tab, only: 'counts', ...query })}`)
  .then(body => typeof body.total === 'number' ? body.total : null);
/**
 * How many people on this tab the filters being chosen would show, of everyone on it (DispatchersFilterSheetPhoneScreen:
 * "6 of 44 people match"). Everyone on the tab is asked once; the match a moment after each change. Null until known, or
 * when the API can't say.
 */
function useMatchCount(filters: Record<string, string>, draft: Record<FilterKey, string>) {
  const [match, setMatch] = useState<number | null>(null), [of, setOf] = useState<number | null>(null);
  const tab = filters.status || MEMBER_DEFAULTS.status, search = filters.search ?? '', draftKey = JSON.stringify(draft);
  useEffect(() => {
    let current = true;
    matchTotal(tab, {}).then(total => { if (current) setOf(total); }, () => { if (current) setOf(null); });
    return () => { current = false; };
  }, [tab]);
  useEffect(() => {
    let current = true;
    const chosen = Object.fromEntries(Object.entries({ ...JSON.parse(draftKey) as Record<string, string>, search }).filter(([, value]) => value));
    const timer = setTimeout(() => {
      matchTotal(tab, chosen).then(total => { if (current) setMatch(total); }, () => { if (current) setMatch(null); });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [draftKey, tab, search]);
  return match === null || of === null ? null : { match, of };
}

/** Every filter on a phone, or Source and Drivers from More filters; nothing changes until Show. */
function FiltersDialog({ all, filters, options, onClose, onApply }: { all: boolean; filters: Record<string, string>; options: MemberOptions; onClose: () => void; onApply: (changes: Record<string, string>) => void }) {
  const [draft, setDraft] = useState<Record<FilterKey, string>>(() => Object.fromEntries(FILTER_KEYS.map(key => [key, filters[key] ?? ''])) as Record<FilterKey, string>);
  const set = (changes: Partial<Record<FilterKey, string>>) => setDraft(current => ({ ...current, ...changes }));
  const count = useMatchCount(filters, draft);
  return <Dialog open onClose={onClose} title={all ? 'Filters' : 'More filters'} protectChanges={false} description={count ? `${count.match} of ${count.of} people match` : undefined}
    actions={<Button onClick={() => onApply(draft)}>Show results</Button>}>
    <div className="grid gap-4">
      {all && <>
        <Select label="MC" value={draft.mcId} onChange={event => set({ mcId: event.target.value, teamId: '' })} options={[{ value: '', label: 'All MCs' }, ...options.mcs.map(mc => ({ value: mc.id, label: archived(mc) }))]} />
        <Select label="Team" value={draft.teamId} hint={draft.mcId ? `Teams under ${options.mcs.find(mc => mc.id === draft.mcId)?.name ?? 'this MC'}.` : undefined} onChange={event => set({ teamId: event.target.value })} options={[{ value: '', label: 'All teams' }, ...teamChoices(options, draft.mcId)]} />
        <Select label="Team lead" value={draft.leadId} onChange={event => set({ leadId: event.target.value })} options={[{ value: '', label: 'All team leads' }, ...options.leads.map(lead => ({ value: lead.id, label: lead.name }))]} />
        <Select label="Position" value={draft.position} onChange={event => set({ position: event.target.value })} options={[{ value: '', label: 'All positions' }, ...POSITIONS]} />
        <Select label="Job title" value={draft.jobTitleId} onChange={event => set({ jobTitleId: event.target.value })} options={[{ value: '', label: 'All job titles' }, ...options.jobTitles.map(title => ({ value: title.id, label: archived(title) }))]} />
      </>}
      <RadioGroup name="member-source" label="Source" value={draft.source} onChange={source => set({ source })} options={SOURCES} />
      <RadioGroup name="member-drivers" label="Drivers" value={draft.drivers} onChange={drivers => set({ drivers })} options={DRIVERS} />
      {/* Everyone on one DAT or Truckstop account (DispatchersLoadBoardFilterScreen). */}
      {!!options.loadBoardAccounts?.length && <Select label="Load board account" value={draft.loadBoardAccountId} onChange={event => set({ loadBoardAccountId: event.target.value })} options={[{ value: '', label: 'All accounts' }, ...options.loadBoardAccounts.map(account => ({ value: account.id, label: archived(account) }))]} />}
      <div><Button variant="ghost" size="sm" onClick={() => setDraft(Object.fromEntries(FILTER_KEYS.map(key => [key, all || key === 'source' || key === 'drivers' || key === 'loadBoardAccountId' ? '' : draft[key]])) as Record<FilterKey, string>)}>Clear all filters</Button></div>
    </div>
  </Dialog>;
}

/** Rows per page: 20, 50 or 100, kept in the URL. */
export function PageSizeSelect({ filters }: { filters: Record<string, string> }) {
  const router = useRouter();
  return <label className="flex items-center gap-2 text-[13px] text-muted-foreground">Rows per page
    <span className="relative flex items-center"><select value={filters.pageSize} onChange={event => router.push(membersHref(filters, { pageSize: event.target.value }))} className={cn(smallSelect, 'w-20')}>
      {['20', '50', '100'].map(size => <option key={size} value={size}>{size}</option>)}
    </select><ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground" /></span>
  </label>;
}

/** Export: the view on screen, every page, work details only (DispatchersExportScreen). The API records it with its count. */
function ExportButton({ filters, total, view }: { filters: Record<string, string>; total: number; view: string }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function download() {
    setBusy(true); setError('');
    try {
      const body = Object.fromEntries(['status', 'search', 'sort', 'direction', ...FILTER_KEYS].filter(key => filters[key]).map(key => [key, filters[key]]));
      const { items } = await mutate<{ items: ExportRow[] }>('dispatch/members/export', 'POST', body);
      const url = URL.createObjectURL(new Blob([membersCsv(items)], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a');
      link.href = url; link.download = `dispatchers-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setOpen(false);
    } catch (caught) { setError(errorMessage(caught, 'The list couldn’t be exported. Try again.')); }
    finally { setBusy(false); }
  }
  return <>
    <Button variant="outline" size="sm" disabled={total === 0} onClick={() => { setError(''); setOpen(true); }}><Download aria-hidden="true" />Export</Button>
    {open && <Dialog open onClose={() => setOpen(false)} busy={busy} protectChanges={false} title={`Export ${total} ${total === 1 ? 'person' : 'people'}`} description={view}
      actions={<Button onClick={download} disabled={busy}><Download aria-hidden="true" />{busy ? 'Preparing…' : 'Download CSV'}</Button>}>
      <div className="grid gap-4 text-sm">
        {error && <Alert tone="danger" title="Not exported">{error}</Alert>}
        <div><p>The file has these columns:</p>
          <ul className="mt-1 list-disc pl-5 text-[13px] leading-5">{['Name', 'Position', 'MC', 'Team', 'Team lead', 'Job title', 'Since', 'Status and last day', 'Company email', 'RingCentral number and extension', 'Telegram'].map(column => <li key={column}>{column}</li>)}</ul></div>
        <Alert tone="info" title="Work details only">Personal email and phone, legal names, load board sign-ins and reasons for leaving aren’t in the file. Open someone’s page for those.</Alert>
        <p className="text-[13px] text-muted-foreground">The export is recorded with its count and the filters used, never the rows. Up to 2,000 people; narrow the filters for more.</p>
      </div>
    </Dialog>}
  </>;
}
