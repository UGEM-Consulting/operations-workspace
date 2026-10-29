import { redirect } from 'next/navigation';
// The onboarding overview became part of the dashboard; keep old links and bookmarks working.
export default function Page() { redirect('/dashboard'); }
