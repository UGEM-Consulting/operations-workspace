import { apiRequest, requirePage } from '@/lib/auth';
import { readResponse } from '@/lib/api-schemas';
import { Invitations } from '@/features/onboarding/invitations';
import { INVITATION_DEFAULTS } from '@/lib/navigation';
import type { Invitation } from '@/features/onboarding/types';
import type { EmploymentOptions } from '@/features/onboarding/employment-picker';
export const metadata = { title: 'Invitations' };
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 await requirePage('invitations');
 const params=await searchParams;
 const filters=Object.fromEntries(Object.entries(INVITATION_DEFAULTS).map(([key,value])=>[key,typeof params[key]==='string'?params[key].slice(0,100):value]));
 const [response,members,...lists]=await Promise.all([apiRequest('onboarding/invitations'),apiRequest('dispatch/members'),apiRequest('lists/mcs?status=ACTIVE'),apiRequest('dispatch/teams?status=ACTIVE'),apiRequest('lists/job-titles?status=ACTIVE')]);
 if(!response.ok)throw new Error('Unable to load invitations');
 // The employment pickers need the managed lists; without them the options dialog offers email and expiry only.
 let options:EmploymentOptions|null=null;
 if(lists.every(list=>list.ok)){
  const [mcs,teams,titles]=await Promise.all(lists.map(list=>list.json())) as [{items:{id:string;name:string}[]},{items:{id:string;name:string;mc:{id:string};lead:{name:string}|null}[]},{items:{id:string;name:string}[]}];
  options={mcs:mcs.items,teams:teams.items.map(team=>({id:team.id,name:team.name,mcId:team.mc.id,lead:team.lead?.name??null})),jobTitles:titles.items};
 }
 // Dispatchers a support can assist (not left; still in IT setup is fine). Without them, the dialog offers dispatchers only.
 const dispatchers=members.ok?((await members.json()) as {items:{id:string;firstName:string;lastName:string;position:string;status:string;mc:string|null;team:string|null}[]}).items
  .filter(member=>member.position==='DISPATCHER'&&member.status!=='LEFT').map(member=>({id:member.id,name:`${member.firstName} ${member.lastName}`.trim(),status:member.status,mc:member.mc,team:member.team})):null;
 return <Invitations initial={await readResponse<Invitation[]>(response,'invitations')} filters={filters} options={options} dispatchers={dispatchers}/>;
}
