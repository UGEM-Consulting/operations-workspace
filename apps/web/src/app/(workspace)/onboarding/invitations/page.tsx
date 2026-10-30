import { apiRequest, requirePage } from '@/lib/auth';
import { choiceListSchema, invitationListSchema, memberListSchema, readResponse, teamListSchema } from '@/lib/api-schemas';
import { Invitations } from '@/features/onboarding/invitations';
import { INVITATION_DEFAULTS } from '@/lib/navigation';
import type { Invitation } from '@/features/onboarding/types';
import type { EmploymentOptions } from '@/features/onboarding/employment-picker';
import type { Choice, MemberList, TeamList } from '@/features/dispatch/types';
export const metadata = { title: 'Invitations' };

/** Reads an optional response for a picker: null when it failed or doesn't have the expected shape, so the page still opens. */
async function optional<T>(response: Response, resource: string, schema: Parameters<typeof readResponse>[2]): Promise<T | null> {
 if (!response.ok) return null;
 try { return await readResponse<T>(response, resource, schema); } catch { return null; }
}

export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 await requirePage('invitations');
 const params=await searchParams;
 const filters=Object.fromEntries(Object.entries(INVITATION_DEFAULTS).map(([key,value])=>[key,typeof params[key]==='string'?params[key].slice(0,100):value]));
 // Supports can assist dispatchers who are onboarding or active (never left), so only those two statuses are fetched.
 const [response,onboarding,active,mcResponse,teamResponse,titleResponse]=await Promise.all([apiRequest('onboarding/invitations'),apiRequest('dispatch/members?status=ONBOARDING'),apiRequest('dispatch/members?status=ACTIVE'),
  apiRequest('lists/mcs?status=ACTIVE'),apiRequest('dispatch/teams?status=ACTIVE'),apiRequest('lists/job-titles?status=ACTIVE')]);
 if(!response.ok)throw new Error('Unable to load invitations');
 const [mcs,teams,titles,onboardingList,activeList]=await Promise.all([optional<{items:Choice[]}>(mcResponse,'MCs',choiceListSchema),optional<TeamList>(teamResponse,'teams',teamListSchema),
  optional<{items:Choice[]}>(titleResponse,'job titles',choiceListSchema),optional<MemberList>(onboarding,'dispatchers',memberListSchema),optional<MemberList>(active,'dispatchers',memberListSchema)]);
 // The employment pickers need the managed lists; without them the options dialog offers email and expiry only.
 const options:EmploymentOptions|null=mcs&&teams&&titles?{mcs:mcs.items.map(({id,name})=>({id,name})),teams:teams.items.map(team=>({id:team.id,name:team.name,mcId:team.mc.id,lead:team.lead?.name??null})),
  jobTitles:titles.items.map(({id,name})=>({id,name}))}:null;
 // Dispatchers a support can assist. Without them, the dialog offers dispatchers only.
 const dispatchers=onboardingList&&activeList?[...onboardingList.items,...activeList.items].filter(member=>member.position==='DISPATCHER')
  .sort((a,b)=>`${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`,undefined,{sensitivity:'base'}))
  .map(member=>({id:member.id,name:`${member.firstName} ${member.lastName}`.trim(),status:member.status,mc:member.mc,team:member.team})):null;
 return <Invitations initial={await readResponse<Invitation[]>(response,'invitations',invitationListSchema)} filters={filters} options={options} dispatchers={dispatchers}/>;
}
