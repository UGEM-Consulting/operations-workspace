'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PageCrumb } from '@/components/shell-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/feedback';
import { Input } from '@/components/ui/field';
import { FilterBar } from '@/components/ui/filter-bar';
import { Table } from '@/components/ui/table';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { LIST_DEFAULTS } from '@/lib/navigation';
import { cn } from '@/lib/utils';

export interface ListItem { id: string; name: string; mcNumber?: string | null; dotNumber?: string | null; archived: boolean; version: number; usage: number }
export interface ListData { items: ListItem[]; counts: { active: number; archived: number } }
export const LISTS = { mcs: { title: 'MCs', one: 'MC', numbers: true }, 'job-titles': { title: 'Job titles', one: 'job title', numbers: false } } as const;
export type ListKey = keyof typeof LISTS;

/**
 * Admin › Lists: the shared choices forms pick from instead of typing. Items are archived, never deleted, so the
 * records that use them keep working. Filters (status, search) live in the URL and apply here, since lists are short.
 */
export function ManagedLists({ list, data, counts, filters }: { list: ListKey; data: ListData; counts: Record<ListKey, number>; filters: Record<string, string> }) {
  const router = useRouter();
  const toast = useToast();
  const { title, one, numbers } = LISTS[list];
  const [editing, setEditing] = useState<ListItem | 'new' | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const query = filters.search.toLowerCase();
  const searched = data.items.filter(item => `${item.name} ${item.mcNumber ?? ''} ${item.dotNumber ?? ''}`.toLowerCase().includes(query));
  const visible = searched.filter(item => filters.status === 'ALL' || item.archived === (filters.status === 'ARCHIVED'));
  const filtered = filters.search !== '' || filters.status !== LIST_DEFAULTS.status;
  const path = `/lists/${list}`;
  function open(item: ListItem | 'new') { setEditing(item); setError(''); }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !editing) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPending('save'); setError('');
    try {
      await (editing === 'new' ? mutate(`lists/${list}`, 'POST', form) : mutate(`lists/${list}/${editing.id}`, 'PATCH', { version: editing.version, ...form }));
      toast({ title: editing === 'new' ? `${capital(one)} added` : `${capital(one)} updated` });
      setEditing(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(null); }
  }
  async function archive(item: ListItem) {
    if (pending) return;
    setPending(item.id);
    try {
      await mutate(`lists/${list}/${item.id}`, 'PATCH', { version: item.version, archived: !item.archived });
      toast({ title: item.archived ? `${item.name} restored` : `${item.name} archived`, description: item.archived ? 'It can be picked again.' : 'It stays on existing records but can’t be picked.' });
      router.refresh();
    } catch (error) { toast({ tone: 'danger', title: 'Not changed', description: errorMessage(error, 'Reload the list and try again.') }); }
    finally { setPending(null); }
  }
  const editItem = editing === 'new' ? null : editing;
  return <div className="space-y-6">
    <PageCrumb label={title} />
    <PageHeader title="Lists" description="Shared choices used across the workspace. Forms pick from these instead of typing, so filters and reports stay accurate."
      action={<Button onClick={() => open('new')}><Plus aria-hidden="true" className="size-4" />Add {one}</Button>} />
    <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <Card className="p-2">
        <nav aria-label="Lists" className="flex gap-1 overflow-x-auto lg:grid">
          {(Object.keys(LISTS) as ListKey[]).map(key => <Link key={key} href={`/lists/${key}`} aria-current={key === list ? 'page' : undefined}
            className={cn('flex h-9 shrink-0 items-center justify-between gap-3 rounded-sm px-3 text-sm', key === list ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
            {LISTS[key].title}<span className="text-xs tabular-nums text-muted-foreground">{counts[key]}</span></Link>)}
        </nav>
      </Card>
      <Card>
        <FilterBar path={path} filters={filters} defaults={LIST_DEFAULTS} searchLabel={numbers ? 'Search name, MC or DOT number' : 'Search name'} statuses={[
          { key: 'ACTIVE', label: 'Active', count: searched.filter(item => !item.archived).length },
          { key: 'ARCHIVED', label: 'Archived', count: searched.filter(item => item.archived).length },
          { key: 'ALL', label: 'All', count: searched.length }]} />
        <Table caption={title} className="border-t border-border" rows={visible} rowKey={item => item.id} columns={[
          { key: 'name', label: numbers ? 'MC' : 'Job title', primary: true, cell: item => <span className="font-medium">{item.name}</span> },
          ...(numbers ? [
            { key: 'mc', label: 'MC number', mono: true, nowrap: true, cell: (item: ListItem) => item.mcNumber ?? <span className="font-sans italic text-muted-foreground">Not set</span> },
            { key: 'dot', label: 'DOT number', mono: true, nowrap: true, hideBelow: 'lg' as const, cell: (item: ListItem) => item.dotNumber ?? <span className="font-sans italic text-muted-foreground">Not set</span> }] : []),
          { key: 'usage', label: 'Used by', muted: true, hideBelow: 'md', cell: item => item.usage ? `${item.usage} approved dispatcher${item.usage === 1 ? '' : 's'}` : 'Not used yet' },
          { key: 'status', label: 'Status', cell: item => <Badge label={item.archived ? 'Archived' : 'Active'} tone={item.archived ? 'neutral' : 'success'} /> },
          { key: 'action', label: 'Actions', srOnly: true, action: true, align: 'right', cell: item => <span className="flex justify-end gap-1">
            <Button variant="outline" size="sm" disabled={!!pending} onClick={() => open(item)}>Edit<span className="sr-only"> {item.name}</span></Button>
            <Button variant="ghost" size="sm" disabled={!!pending} onClick={() => void archive(item)}>{pending === item.id ? 'Saving…' : item.archived ? 'Restore' : 'Archive'}<span className="sr-only"> {item.name}</span></Button></span> },
        ]} empty={filtered ? <EmptyState compact title="Nothing matches these filters" description="Try another status or search." />
          : <EmptyState compact title={`No ${title.toLowerCase()} yet`} description={`Add the first ${one}; it appears in every picker straight away.`} action={<Button onClick={() => open('new')}><Plus aria-hidden="true" className="size-4" />Add {one}</Button>} />}
          footer={<p className="text-[13px] text-muted-foreground">Archived {title === 'MCs' ? 'MCs' : 'job titles'} stay on existing records but can’t be picked.</p>} />
      </Card>
    </div>
    {editing && <Dialog open onClose={() => setEditing(null)} busy={pending === 'save'} title={editItem ? `Edit ${editItem.name}` : `Add ${one}`}
      description={editItem ? 'Records that use it show the new name.' : 'It appears in every picker straight away.'}
      actions={<Button type="submit" form="list-item">{pending === 'save' ? 'Saving…' : editItem ? 'Save changes' : `Add ${one}`}</Button>}>
      <form id="list-item" onSubmit={save} className="space-y-4">
        <Input label="Name" name="name" defaultValue={editItem?.name} required maxLength={100} autoComplete="off" width="full" />
        {numbers && <div className="grid gap-4 sm:grid-cols-2">
          <Input label="MC number" optional name="mcNumber" defaultValue={editItem?.mcNumber ?? ''} inputMode="numeric" maxLength={12} autoComplete="off" hint="Digits only." width="full" />
          <Input label="DOT number" optional name="dotNumber" defaultValue={editItem?.dotNumber ?? ''} inputMode="numeric" maxLength={14} autoComplete="off" hint="Digits only." width="full" />
        </div>}
        {numbers && <p className="text-[13px] leading-5 text-muted-foreground">Applicants only ever see the name, never the MC or DOT number.</p>}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </div>;
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
