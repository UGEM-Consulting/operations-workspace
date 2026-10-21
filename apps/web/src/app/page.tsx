import { redirect } from 'next/navigation';
import { requireIdentity } from '@/lib/auth';
export default async function Home() { const identity = await requireIdentity(); redirect(identity.landingPage); }
