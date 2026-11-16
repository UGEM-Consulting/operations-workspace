import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { loadBoardAccountsSchema, managedListSchema, readResponse } from '@/lib/api-schemas';
import { LIST_DEFAULTS } from '@/lib/navigation';
import { ManagedLists, type ListData, type ListKey } from '@/features/lists/managed-lists';
import { LoadBoardAccountList, type AccountList } from '@/features/load-boards/accounts';
export const metadata = { title: 'Lists' };
// IT keeps only the load board accounts (section 33); dispatch managers read them beside MCs and job titles.
const listsFor = (role: string): ListKey[] => role === 'IT_SPECIALIST' ? ['load-board-accounts'] : ['mcs', 'job-titles', 'load-board-accounts'];
export default async function ListPage({ params, searchParams }: { params: Promise<{ list: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requirePage('lists');
  const keys = listsFor(identity.user.role);
  const { list } = await params;
  if (!keys.includes(list as ListKey)) notFound();
  const query = await searchParams;
  const filters = Object.fromEntries(Object.entries(LIST_DEFAULTS).map(([key, value]) => [key, typeof query[key] === 'string' ? query[key].slice(0, 100) : value]));
  // Every list is fetched for the counts beside each name; they are short.
  const responses = await Promise.all(keys.map(key => apiRequest(`lists/${key}`)));
  if (responses.some(response => !response.ok)) throw new Error('Unable to load lists');
  const all = await Promise.all(responses.map((response, index) => readResponse<ListData & Partial<AccountList>>(response, keys[index], keys[index] === 'load-board-accounts' ? loadBoardAccountsSchema : managedListSchema)));
  const counts = Object.fromEntries(keys.map((key, index) => [key, all[index].counts.active])) as Partial<Record<ListKey, number>>;
  const data = all[keys.indexOf(list as ListKey)];
  if (list === 'load-board-accounts') {
    const accounts = data as unknown as AccountList, canChange = ['SYSTEM_ADMIN', 'IT_SPECIALIST'].includes(identity.user.role);
    return <ManagedLists list="load-board-accounts" lists={keys} data={data} counts={counts} filters={filters} canAdd={false}
      content={<LoadBoardAccountList data={accounts} filters={filters} canChange={canChange} />} />;
  }
  return <ManagedLists list={list as ListKey} lists={keys} data={data} counts={counts} filters={filters} />;
}
