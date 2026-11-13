import type { MemberOptions } from './types.ts';

// The filters' names and the search mark, without framework imports so the server page, the client filters and node tests share them.
/** The filters under the tabs; search, tab, sort and page live beside them in the URL. */
export const FILTER_KEYS = ['mcId', 'teamId', 'leadId', 'position', 'jobTitleId', 'source', 'drivers'] as const;
export type FilterKey = typeof FILTER_KEYS[number];
export const POSITIONS = [{ value: 'DISPATCHER', label: 'Dispatcher' }, { value: 'SUPPORT', label: 'Support' }, { value: 'UPDATER', label: 'Updater' }];
export const SOURCES = [{ value: '', label: 'Everyone' }, { value: 'ONBOARDED', label: 'Came through onboarding' }, { value: 'ADDED', label: 'Added by hand' }];
export const DRIVERS = [{ value: '', label: 'Everyone' }, { value: 'WITH', label: 'With drivers' }, { value: 'WITHOUT', label: 'Without drivers' }];
export const FILTER_LABELS: Record<FilterKey, string> = { mcId: 'MC', teamId: 'Team', leadId: 'Team lead', position: 'Position', jobTitleId: 'Job title', source: 'Source', drivers: 'Drivers' };
export const archived = (item: { name: string; archived?: boolean }) => item.archived ? `${item.name} (archived)` : item.name;

/** What a chosen filter says on its chip and in the export's description. */
export function chipValue(key: FilterKey, value: string, options: MemberOptions) {
  const named = (items: { id: string; name: string; archived?: boolean }[]) => { const item = items.find(entry => entry.id === value); return item ? archived(item) : 'Not listed'; };
  switch (key) {
    case 'mcId': return named(options.mcs);
    case 'teamId': return value === 'NONE' ? 'Independent (no team)' : named(options.teams);
    case 'leadId': return named(options.leads);
    case 'jobTitleId': return named(options.jobTitles);
    case 'position': return POSITIONS.find(item => item.value === value)?.label ?? value;
    case 'source': return SOURCES.find(item => item.value === value)?.label ?? value;
    case 'drivers': return DRIVERS.find(item => item.value === value)?.label ?? value;
  }
}

/** The view in words, as the export dialog describes it (DispatchersExportScreen): "Active · MC: Northwind Freight · sorted by name". */
export function describeView(tabLabel: string, filters: Record<string, string>, options: MemberOptions) {
  const sort = { lead: 'team lead', mc: 'MC' }[filters.sort] ?? (filters.sort || 'name');
  return [tabLabel, ...FILTER_KEYS.filter(key => filters[key]).map(key => `${FILTER_LABELS[key]}: ${chipValue(key, filters[key], options)}`),
    filters.search && `search “${filters.search}”`, `sorted by ${sort}`].filter(Boolean).join(' · ');
}

/**
 * Where a search matched a contact detail, to mark it (DispatchersSearchContactScreen): a number by its digits whatever the
 * separators, with or without the US 1, as the API matches it (searchTerms in member-list.ts); anything else as text.
 */
export function matchedRange(value: string, search: string): [number, number] | null {
  const trimmed = search.trim();
  const digits = trimmed.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (/^[\d\s()+.-]+$/.test(trimmed) && digits.length >= 3) {
    const positions = [...value].flatMap((char, index) => /\d/.test(char) ? [index] : []);
    const at = positions.map(index => value[index]).join('').indexOf(digits);
    return at < 0 ? null : [positions[at], positions[at + digits.length - 1] + 1];
  }
  const text = trimmed.toLowerCase().replace(/^@/, '');
  const at = text ? value.toLowerCase().indexOf(text) : -1;
  return at < 0 ? null : [at, at + text.length];
}
