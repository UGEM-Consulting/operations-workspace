import { DISPATCH, ListPage } from '@/features/announcements/pages';
export const metadata = { title: 'Announcements' };
export default function AnnouncementsPage() { return ListPage(DISPATCH); }
