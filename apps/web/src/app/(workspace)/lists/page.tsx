import { redirect } from 'next/navigation';
import { requirePage } from '@/lib/auth';
// IT's Lists holds only the load board accounts (section 33).
export default async function Page() {
  const identity = await requirePage('lists');
  redirect(identity.user.role === 'IT_SPECIALIST' ? '/lists/load-board-accounts' : '/lists/mcs');
}
