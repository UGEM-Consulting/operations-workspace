'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, FileText, Search, Truck, UserCheck, Users } from 'lucide-react';
import { readApi } from '@/lib/client-api';
import { cn } from '@/lib/utils';
import { Avatar } from './ui/avatar';
import { Button } from './ui/button';
import { inputClass } from './ui/field';
import { Badge, type StatusTone } from './ui/status-badge';

// Search as you type (designed as SearchTypeaheadScreen, SearchContactScreen, SearchNoMatchScreen, SearchPhoneScreen and
// SearchEverywhereScreen, section 35, approved 2026-11-17). From 3 letters or digits the box shows matches as you type;
// arrow keys and Enter open one, Enter on the box keeps doing what it did before (filtering the table), Esc closes.

type Icon = 'person' | 'team' | 'lead' | 'driver' | 'application';
export interface SuggestItem { id: string; name: string; meta: string; status: { label: string; tone: StatusTone } | null; href: string; icon: Icon }
export interface SuggestGroup { label: string; items: SuggestItem[] }
export interface SuggestAnswer { groups: SuggestGroup[]; total: number | null }
type Source = 'dispatchers' | 'everywhere';

const MIN = 3;
/** Enough to search: 3 letters, or 3 digits of a number. */
export const searchable = (query: string) => query.replace(/\s/g, '').length >= MIN || query.replace(/\D/g, '').length >= MIN;
const digitsOnly = (query: string) => /^[\d\s()+.-]+$/.test(query.trim());

/** The typed letters (or digits of a number) marked in a line, as the design shows them. */
function Marked({ text, query }: { text: string; query: string }) {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return <>{text}</>;
  if (digitsOnly(query)) {
    const digits = wanted.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    const positions = [...text].flatMap((char, index) => /\d/.test(char) ? [index] : []), all = positions.map(index => text[index]).join('');
    const at = digits ? all.indexOf(digits) : -1;
    if (at < 0) return <>{text}</>;
    const start = positions[at], end = positions[at + digits.length - 1] + 1;
    return <>{text.slice(0, start)}<mark className="rounded-sm bg-warning-background px-px font-semibold text-inherit">{text.slice(start, end)}</mark>{text.slice(end)}</>;
  }
  const at = text.toLowerCase().indexOf(wanted);
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="rounded-sm bg-warning-background px-px font-semibold text-inherit">{text.slice(at, at + wanted.length)}</mark>{text.slice(at + wanted.length)}</>;
}

/** A dispatcher, support or updater from GET dispatch/members/suggest, named as the Dispatchers page names them. */
interface SuggestedPerson { id: string; firstName: string; lastName: string; position: string; supportType?: string; status: string; lastDay: string | null; leave: { started?: boolean } | null; team: string | null; wholeTeam: string | null; lead: boolean; dispatcher: string | null; matched: { label: string; value: string } | null }
export function personItem(person: SuggestedPerson): SuggestItem {
  const support = person.position === 'SUPPORT', kind = support ? (person.supportType === 'UPDATER' ? 'Updater' : 'Support') : 'Dispatcher';
  const place = support ? `${kind} for ${person.wholeTeam ? `the whole ${person.wholeTeam}` : person.dispatcher ?? 'nobody yet'}` : [person.lead ? 'Dispatcher · team lead' : kind, person.team].filter(Boolean).join(' · ');
  const status = person.status === 'LEFT' ? { label: 'Left', tone: 'neutral' as const } : person.lastDay ? { label: 'Leaving', tone: 'warning' as const }
    : person.leave?.started ? { label: 'On leave', tone: 'info' as const } : person.status === 'ONBOARDING' ? { label: 'Onboarding', tone: 'info' as const } : { label: 'Active', tone: 'success' as const };
  return { id: person.id, name: `${person.firstName} ${person.lastName}`, meta: person.matched ? `${person.matched.label}: ${person.matched.value}` : place, status, href: `/dispatch/dispatchers/${person.id}`, icon: 'person' };
}

async function ask(source: Source, query: string, filterHref?: (changes: Record<string, string>) => string): Promise<SuggestAnswer> {
  if (source === 'everywhere') {
    const answer = await readApi<{ groups: { key: string; label: string; items: Omit<SuggestItem, 'icon'>[] }[] }>(`search?${new URLSearchParams({ q: query })}`);
    const icons: Record<string, Icon> = { dispatchers: 'person', drivers: 'driver', applications: 'application', teams: 'team' };
    return { groups: answer.groups.map(group => ({ label: group.label, items: group.items.map(item => ({ ...item, icon: icons[group.key] ?? 'person' })) })), total: null };
  }
  const answer = await readApi<{ people: SuggestedPerson[]; teams: { id: string; name: string; mc: string; count: number }[]; leads: { id: string; name: string; count: number }[]; total: number }>(`dispatch/members/suggest?${new URLSearchParams({ q: query })}`);
  const people = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`;
  const filters = filterHref ? [...answer.teams.map(team => ({ id: `team-${team.id}`, name: team.name, meta: `Team · ${team.mc} · ${people(team.count)}`, status: null, href: filterHref({ teamId: team.id, mcId: '', search: '' }), icon: 'team' as const })),
    ...answer.leads.map(lead => ({ id: `lead-${lead.id}`, name: `Led by ${lead.name}`, meta: `Team lead filter · ${people(lead.count)}`, status: null, href: filterHref({ leadId: lead.id, search: '' }), icon: 'lead' as const }))] : [];
  return { groups: [{ label: 'People', items: answer.people.map(personItem) }, ...(filters.length ? [{ label: 'Show in the table', items: filters }] : [])].filter(group => group.items.length), total: answer.total };
}

function Lead({ item }: { item: SuggestItem }) {
  if (item.icon === 'person') return <Avatar name={item.name} size="sm" />;
  const Icon = { team: Users, lead: UserCheck, driver: Truck, application: FileText }[item.icon];
  return <span className="inline-grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><Icon aria-hidden="true" className="size-3.5" /></span>;
}
function Key({ children }: { children: ReactNode }) {
  return <kbd className="inline-block min-w-5 rounded-[5px] border border-b-2 border-border bg-background px-1 text-center font-mono text-[11px] leading-[18px] text-muted-foreground">{children}</kbd>;
}

/**
 * The search box with its dropdown. source picks what it searches; onSubmit is Enter on the box (or See all), as before.
 * On phones the box opens a full-screen search (SearchPhoneScreen) with the same rows.
 */
export function SearchSuggest({ source, label, value, onChange, onSubmit, filterHref, className, shortcut = false, autoFocus = false, iconOnPhone = false }: {
  source: Source; label: string; value: string; onChange: (value: string) => void; onSubmit?: (value: string) => void;
  filterHref?: (changes: Record<string, string>) => string; className?: string; shortcut?: boolean; autoFocus?: boolean;
  /** In the top bar a phone shows a search button, which opens the full-screen search. */ iconOnPhone?: boolean;
}) {
  const router = useRouter(), id = useId(), input = useRef<HTMLInputElement>(null), phoneInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [stored, setAnswer] = useState<SuggestAnswer | null>(null), [answered, setAnswered] = useState(''), [active, setActive] = useState(-1), [phone, setPhone] = useState(false);
  const asked = useRef(0);
  // The filters the offered filter rows build on: a change of filters asks again, so those rows keep what was chosen since.
  const filterKey = filterHref?.({}) ?? '';
  // The last answer while the next is on its way; none once the box holds too little to search.
  const answer = searchable(value.trim()) ? stored : null;
  const items = answer?.groups.flatMap(group => group.items) ?? [];
  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)'), update = () => setPhone(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  // Asked a moment after typing stops; an answer for an earlier query is dropped, and nothing shows while the first is on its way.
  useEffect(() => {
    const query = value.trim(), ask_ = ++asked.current;
    if (!searchable(query)) return;
    const timer = setTimeout(() => {
      ask(source, query, filterHref).then(result => { if (ask_ === asked.current) { setAnswer(result); setAnswered(query); setActive(-1); } })
        .catch(() => { if (ask_ === asked.current) { setAnswer({ groups: [], total: 0 }); setAnswered(query); } });
    }, 250);
    return () => clearTimeout(timer);
    // filterHref is a new function every render; filterKey stands for what it builds on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, source, filterKey]);
  // Ctrl K (or ⌘K) focuses the top bar's search from anywhere.
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (window.matchMedia('(max-width: 639px)').matches) setOpen(true); else input.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut]);
  useEffect(() => { if (phone && open) phoneInput.current?.focus(); }, [phone, open]);

  function go(item: SuggestItem) { setOpen(false); router.push(item.href); }
  function submit() { setOpen(false); if (onSubmit) onSubmit(value.trim()); else if (items[0]) go(items[0]); }
  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); setOpen(true); setActive(index => (index + 1) % items.length); }
    else if (event.key === 'ArrowUp' && items.length) { event.preventDefault(); setOpen(true); setActive(index => (index <= 0 ? items.length : index) - 1); }
    else if (event.key === 'Enter') { event.preventDefault(); if (active >= 0 && items[active]) go(items[active]); else submit(); }
    else if (event.key === 'Escape') { if (open) { event.preventDefault(); setOpen(false); setActive(-1); } }
  }
  const query = value.trim(), short = query.length > 0 && !searchable(query), more = MIN - query.replace(/\s/g, '').length;
  const nothing = !!answer && answered === query && !items.length;
  const everyone = source === 'dispatchers' ? 'Searched everyone, people who left included: names, other names, emails and phone numbers. Check the spelling, or try part of an email or number.' : 'Only what you can open is searched. Check the spelling, or try part of a name.';
  const list = (big: boolean) => <div id={`${id}-list`} role="listbox" aria-label="Matches" className={big ? '' : 'py-1.5'}>
    {answer?.groups.map(group => <div key={group.label} role="group" aria-label={group.label}>
      <div className="px-3.5 pb-1 pt-2.5 text-xs font-semibold uppercase tracking-[.04em] text-muted-foreground">{group.label}</div>
      {group.items.map(item => { const index = items.indexOf(item);
        return <div key={item.id} id={`${id}-${index}`} role="option" aria-selected={index === active} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => go(item)}
          className={cn('flex cursor-pointer items-center gap-2.5 px-3.5', big ? 'py-3' : 'py-2', index === active && 'bg-accent')}>
          <Lead item={item} />
          <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium"><Marked text={item.name} query={query} /></div><div className="truncate text-[13px] leading-[18px] text-muted-foreground"><Marked text={item.meta} query={query} /></div></div>
          {item.status && <Badge label={item.status.label} tone={item.status.tone} />}
        </div>; })}
    </div>)}
    {nothing && <div role="status" className="grid gap-1 p-3.5"><b className="text-sm font-semibold">No one matches “{query}”</b><span className="text-[13px] leading-5 text-muted-foreground">{everyone}</span></div>}
    {short && <div role="status" className="p-3.5 text-[13px] text-muted-foreground">Type {more} more {more === 1 ? 'letter' : 'letters'} to search.</div>}
  </div>;
  const seeAll = source === 'dispatchers' && onSubmit && items.length > 0 && answer?.total !== null;

  return <div className={cn('relative', className)}>
    {iconOnPhone && phone ? <Button variant="ghost" size="icon" aria-label={label} onClick={() => setOpen(true)}><Search aria-hidden="true" className="size-5" /></Button>
    : <form role="search" onSubmit={event => { event.preventDefault(); submit(); }}>
      <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input ref={input} type="search" role="combobox" aria-label={label} placeholder={label} value={value} maxLength={100} autoComplete="off" autoFocus={autoFocus}
        aria-expanded={open && !phone && (items.length > 0 || nothing || short)} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
        onChange={event => { onChange(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => { if (!phone) setTimeout(() => setOpen(false), 0); }} onKeyDown={keyDown}
        className={cn(inputClass, 'mt-0 w-full pl-8', shortcut && 'pr-14')} />
      {shortcut && !value && <span aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 max-sm:hidden"><Key>Ctrl</Key> <Key>K</Key></span>}
    </form>}
    {open && !phone && (items.length > 0 || nothing || short) && <div className={cn('absolute top-[calc(100%+6px)] z-40 w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg', iconOnPhone ? 'right-0 w-[min(520px,calc(100vw-32px))]' : 'left-0')}>
      {list(false)}
      {(seeAll || items.length > 0) && <div className="mt-1 flex items-center justify-between gap-3 border-t border-border px-3.5 pb-1 pt-2 text-[13px] text-muted-foreground">
        {seeAll ? <button type="button" onMouseDown={event => event.preventDefault()} onClick={submit} className="text-left hover:underline"><b className="font-medium text-foreground">See all {answer!.total} {answer!.total === 1 ? 'person' : 'people'}</b> in the table</button> : <span>Only what you can open</span>}
        <span className="max-md:hidden"><Key>↑</Key> <Key>↓</Key> to choose · <Key>Enter</Key> to open · <Key>Esc</Key></span></div>}
    </div>}
    {open && phone && <div role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-50 grid grid-rows-[auto_1fr] bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon" aria-label="Back" onClick={() => setOpen(false)}><ArrowLeft aria-hidden="true" className="size-5" /></Button>
        <input ref={phoneInput} type="search" role="combobox" aria-label={label} placeholder={label} value={value} maxLength={100} autoComplete="off" aria-expanded aria-controls={`${id}-list`}
          onChange={event => onChange(event.target.value)} onKeyDown={keyDown} className={cn(inputClass, 'mt-0 w-full')} />
      </div>
      <div className="overflow-y-auto">{list(true)}
        {seeAll && <div className="px-3.5 py-3"><Button variant="outline" className="w-full" onClick={submit}>See all {answer!.total} {answer!.total === 1 ? 'person' : 'people'}</Button></div>}</div>
    </div>}
  </div>;
}
