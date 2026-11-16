import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { loadBoardAccountSchema, loadBoardAccountsSchema, readResponse, seatPeopleSchema } from '@/lib/api-schemas';
import { LoadBoardAccountView, type AccountList, type AccountPage } from '@/features/load-boards/accounts';
import type { SeatPerson } from '@/features/load-boards/seats';
export const metadata = { title: 'Load board account' };
/** One load board account (LoadBoardAccountScreen). Only that list has pages of its own. */
export default async function AccountPageRoute({ params }: { params: Promise<{ list: string; id: string }> }) {
  const identity = await requirePage('lists');
  const { list, id } = await params;
  if (list !== 'load-board-accounts' || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const keeper = ['SYSTEM_ADMIN', 'IT_SPECIALIST'].includes(identity.user.role);
  const [page, accounts, people] = await Promise.all([apiRequest(`lists/load-board-accounts/${id}`), apiRequest('lists/load-board-accounts'), keeper ? apiRequest('load-board-seats/people') : null]);
  if (page.status === 404) notFound();
  if (!page.ok || !accounts.ok || (people && !people.ok)) throw new Error('Unable to load the load board account');
  const [data, accountList, peopleList] = await Promise.all([readResponse<AccountPage>(page, 'load board account', loadBoardAccountSchema), readResponse<AccountList>(accounts, 'load board accounts', loadBoardAccountsSchema), people ? readResponse<SeatPerson[]>(people, 'people', seatPeopleSchema) : []]);
  return <LoadBoardAccountView data={data} accounts={accountList.items} people={peopleList} canChange={keeper} linkPeople={identity.user.role !== 'IT_SPECIALIST'} />;
}
