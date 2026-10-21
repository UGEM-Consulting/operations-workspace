import { requirePage } from '@/lib/auth';
import { PlaceholderPage } from "@/components/placeholder-page";
export const metadata = { title: "IT tasks" };
export default async function Page() { await requirePage('it'); return <PlaceholderPage title="IT tasks" description="A future home for internal IT coordination." />; }
