import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { PageCrumb } from '@/components/shell-context';
import { TelegramGroups, type TelegramData } from '@/features/telegram/groups';
export const metadata = { title: 'Telegram' };
/** Admin › Telegram (section 34): the groups linked to the workspace and where each alert goes. Administrators only. */
export default async function TelegramPage() {
  await requirePage('telegram');
  const response = await apiRequest('telegram/groups');
  if (!response.ok) throw new Error('Unable to load Telegram groups');
  const data = await readResponse<TelegramData>(response, 'Telegram groups');
  return <div className="space-y-6"><PageCrumb label="Telegram" /><TelegramGroups data={data} /></div>;
}
