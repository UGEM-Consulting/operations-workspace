import { ApplicantAccess } from '@/features/onboarding/applicant-access';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{token:string}>}) { const {token}=await params;if(!/^[a-f0-9]{64}$/.test(token))return <p>This invitation is invalid. Ask your manager for a new link.</p>;return <ApplicantAccess token={token}/>; }
