import { TEAM, NewPage } from '@/features/announcements/pages';
export const metadata = { title: 'New announcement' };
export default async function NewAnnouncementPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { team } = await searchParams;
  return NewPage(TEAM, typeof team === 'string' ? team : undefined);
}
