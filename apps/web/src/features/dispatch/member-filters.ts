import { MEMBER_DEFAULTS } from '@/lib/navigation';

// Shared by the server page and the client filters: a server page can't call a function exported from a 'use client' module.
const PATH = '/dispatch/dispatchers';
/** The filters under the tabs; search, tab, sort and page live beside them in the URL. */
export const FILTER_KEYS = ['mcId', 'teamId', 'leadId', 'position', 'jobTitleId', 'source', 'drivers'] as const;
export type FilterKey = typeof FILTER_KEYS[number];
/** A Dispatchers URL with these changes, back to page 1, leaving out whatever is at its default so links stay short. */
export function membersHref(filters: Record<string, string>, changes: Record<string, string>) {
  const next = { ...filters, page: '1', ...changes };
  const params = new URLSearchParams(Object.entries(next).filter(([key, value]) => value !== '' && MEMBER_DEFAULTS[key] !== value));
  return params.size ? `${PATH}?${params}` : PATH;
}
