import { DISPATCH, DetailPage } from '@/features/announcements/pages';
export const metadata = { title: 'Announcement' };
export default async function AnnouncementDetailPage({ params }: { params: Promise<{ id: string }> }) { return DetailPage(DISPATCH, (await params).id); }
