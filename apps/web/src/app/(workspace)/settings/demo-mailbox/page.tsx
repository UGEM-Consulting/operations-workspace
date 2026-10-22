import { notFound } from 'next/navigation';
import { apiRequest, requirePage } from '@/lib/auth';
import { DemoMailbox } from '@/features/demo-email/mailbox';
export const metadata = { title: 'Demo mailbox' };
export default async function DemoMailboxPage() {
  await requirePage('settings');
  const response = await apiRequest('demo-mailbox');
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error('Demo mailbox unavailable. Check administrator access and demo isolation.');
  return <div><h1 className="text-3xl font-normal">Demo mailbox</h1><p className="mt-3 text-sm text-muted-foreground">Demo Environment — Fictional Data Only</p><DemoMailbox messages={await response.json()} /></div>;
}
