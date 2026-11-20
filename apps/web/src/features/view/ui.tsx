import Link from 'next/link';
import { Eye } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { apiRequest } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';

// View-only access (Design System section 39: ViewOnlyDispatchersScreen, ViewOnlyDispatcherScreen, ViewOnlyFilesScreen,
// ViewOnlyHistoryScreen, ViewOnlyDriverScreen, ViewOnlyNoAccessScreen, ViewOnlyPhonePageScreen; approved 2026-11-20).
// Plain components for the server pages; nothing here changes a record.

/** The dashed View only mark beside a page's title or status. */
export function ViewOnlyMark() {
  return <span className="inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-md border border-dashed border-border px-2 text-xs font-medium text-muted-foreground"><Eye aria-hidden="true" className="size-3.5" />View only</span>;
}

/** The note at the end of a page: what stays with the department. */
export function LookNote({ children }: { children: React.ReactNode }) {
  return <Alert tone="info" title="You can look, not change"><p>{children}</p></Alert>;
}

/** A view-only answer, or null when the grant was taken away (403) or the record is gone (404): the page says so. */
export async function viewRead<T>(path: string, what: string): Promise<T | null> {
  const response = await apiRequest(`view/${path}`);
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Unable to load ${what}`);
  return readResponse<T>(response, what);
}

/** When a record is gone or access changed while the page was open. */
export function NotAvailable({ back, label }: { back: string; label: string }) {
  return <div className="space-y-4"><Alert tone="warning" title="This isn’t available"><p>It may have been removed, or your view-only access changed.</p></Alert>
    <Link href={back} className="text-sm font-medium text-primary hover:underline">Back to {label}</Link></div>;
}

/** A dispatcher's status as Dispatch words it, for viewers. */
export function memberState(row: { status: string; lastDay?: string | null; leave?: { started: boolean } | null }): { label: string; tone: 'success' | 'info' | 'warning' | 'neutral' } {
  if (row.status === 'LEFT') return { label: 'Left', tone: 'neutral' };
  if (row.lastDay) return { label: 'Leaving', tone: 'warning' };
  if (row.leave?.started) return { label: 'On leave', tone: 'info' };
  if (row.status === 'ONBOARDING') return { label: 'Onboarding', tone: 'info' };
  return { label: 'Active', tone: 'success' };
}
