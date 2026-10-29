'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { queueHref } from '@/lib/navigation';
import { inputClass } from './field';
import { TabLinks, type TabItem } from './tabs';

export interface SortOption { value: string; label: string }

/**
 * The toolbar above every queue: status tabs with counts, search, one sort menu and Clear. Filters live in the URL,
 * so the server renders the filtered list and links can be shared. Sort values are "field:direction".
 */
export function FilterBar({ path, filters, statuses, statusKey = 'status', searchLabel, sortOptions, defaults }: {
  path: string; filters: Record<string, string>; statuses: (TabItem & { key: string })[]; statusKey?: string; searchLabel: string;
  sortOptions: SortOption[]; defaults: Record<string, string>;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(filters.search ?? '');
  const sortValue = `${filters.sort}:${filters.direction}`;
  const filtered = (filters.search ?? '') !== '' || filters[statusKey] !== defaults[statusKey] || filters.sort !== defaults.sort || filters.direction !== defaults.direction;
  // Tabs and controls share a row only on very wide screens; otherwise the controls sit below the tabs, which scroll sideways if needed.
  return <div className="flex flex-col gap-3 px-4 pb-3 pt-4 sm:px-5 2xl:flex-row 2xl:items-center 2xl:justify-between">
    <TabLinks className="min-w-0 self-start" variant="segmented" label="Status" value={filters[statusKey]} items={statuses.map(status => ({ ...status, href: queueHref(path, filters, { [statusKey]: status.key }) }))} />
    <div className="flex flex-wrap items-center gap-2 2xl:shrink-0 2xl:flex-nowrap">
      <form role="search" className="relative min-w-0 basis-full sm:w-56 sm:basis-auto sm:flex-none" onSubmit={event => { event.preventDefault(); router.push(queueHref(path, filters, { search: query.trim() })); }}>
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input type="search" aria-label={searchLabel} placeholder={searchLabel} value={query} maxLength={100} onChange={event => setQuery(event.target.value)} className={cn(inputClass, 'mt-0 w-full pl-8')} />
      </form>
      <label className="sr-only" htmlFor="queue-sort">Sort</label>
      <div className="relative flex items-center"><select id="queue-sort" value={sortOptions.some(option => option.value === sortValue) ? sortValue : ''} className={cn(inputClass, 'mt-0 w-auto cursor-pointer appearance-none pr-9')}
        onChange={event => { const [sort, direction] = event.target.value.split(':'); router.push(queueHref(path, filters, { sort, direction })); }}>
        {!sortOptions.some(option => option.value === sortValue) && <option value="" disabled>Custom order</option>}
        {sortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select><ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground" /></div>
      {filtered && <Link href={queueHref(path, filters, { ...defaults, search: '' })} onClick={() => setQuery('')} className="inline-flex min-h-(--control) items-center gap-1 rounded-sm px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"><X aria-hidden="true" className="size-4" />Clear</Link>}
    </div>
  </div>;
}
