import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { managedListSchema, readResponse } from '@/lib/api-schemas';
import { LIST_DEFAULTS } from '@/lib/navigation';
import { ManagedLists, type ListData, type ListKey } from '@/features/lists/managed-lists';
export const metadata = { title: 'Lists' };
const KEYS: ListKey[] = ['mcs', 'job-titles'];
export default async function ListPage({ params, searchParams }: { params: Promise<{ list: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage('lists');
  const { list } = await params;
  if (!KEYS.includes(list as ListKey)) notFound();
  const query = await searchParams;
  const filters = Object.fromEntries(Object.entries(LIST_DEFAULTS).map(([key, value]) => [key, typeof query[key] === 'string' ? query[key].slice(0, 100) : value]));
  // Every list is fetched for the counts beside each name; they are short.
  const responses = await Promise.all(KEYS.map(key => apiRequest(`lists/${key}`)));
  if (responses.some(response => !response.ok)) throw new Error('Unable to load lists');
  const all = await Promise.all(responses.map((response, index) => readResponse<ListData>(response, KEYS[index], managedListSchema)));
  const counts = Object.fromEntries(KEYS.map((key, index) => [key, all[index].counts.active])) as Record<ListKey, number>;
  return <ManagedLists list={list as ListKey} data={all[KEYS.indexOf(list as ListKey)]} counts={counts} filters={filters} />;
}
