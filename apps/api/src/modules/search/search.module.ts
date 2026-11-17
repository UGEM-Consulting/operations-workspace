import { Controller, Get, Injectable, Module, Query, Req } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { Roles } from '../auth/policy';
import { AuthRequest } from '../auth/session';
import { DispatchModule } from '../dispatch/dispatch.module';
import { escapeLike, MemberListService, searchTerms } from '../dispatch/member-list';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { ReviewService } from '../onboarding/review.service';
import { Role, type User } from '../users/user.entity';

class SearchQueryDto { @IsString() @MaxLength(100) q!: string }
type Tone = 'success' | 'info' | 'warning' | 'neutral' | 'danger';
export interface SearchItem { id: string; name: string; meta: string; status: { label: string; tone: Tone } | null; href: string }
export interface SearchGroup { key: 'dispatchers' | 'drivers' | 'applications' | 'teams'; label: string; items: SearchItem[] }

const SAFETY = [Role.SAFETY_MANAGER, Role.SAFETY_LEAD, Role.SAFETY_STAFF];
const DRIVER_STATUS: Record<string, [string, Tone]> = { LEAD: ['Lead', 'neutral'], APPLYING: ['Applying', 'info'], SCREENING: ['Screening', 'info'], AWAITING_DECISION: ['Awaiting decision', 'warning'],
 PRE_ADVERSE: ['Pre-adverse', 'warning'], APPROVED: ['Approved', 'success'], CLEARED: ['Cleared', 'success'], REJECTED: ['Rejected', 'neutral'], WITHDRAWN: ['Withdrawn', 'neutral'], LEFT: ['Left', 'neutral'] };
const APPLICATION_STATUS: Record<string, [string, Tone]> = { INVITED: ['Invited', 'neutral'], DRAFT: ['Draft', 'neutral'], SUBMITTED: ['Awaiting review', 'warning'], RESUBMITTED: ['Awaiting review', 'warning'],
 CHANGES_REQUESTED: ['Changes requested', 'info'], APPROVED: ['Approved', 'success'], REJECTED: ['Rejected', 'neutral'] };
const DRIVER_TYPE: Record<string, string> = { COMPANY: 'Company driver', OWNER_OPERATOR: 'Owner-operator' };
const LICENSE: Record<string, string> = { CDL_A: 'CDL A', CDL_B: 'CDL B', CDL_C: 'CDL C', DL: 'DL' };
const status = (map: Record<string, [string, Tone]>, key: string) => { const [label, tone] = map[key] ?? [key, 'neutral' as Tone]; return { label, tone }; };

/**
 * The search in the top bar (designed as SearchEverywhereScreen, section 35, approved 2026-11-17): people across the workspace
 * from 3 letters, grouped by where they live, only what the signed-in person may open, by the same rules as each page. Each
 * group reuses that page's own query or scope: Dispatchers (MemberListService), applications (ReviewService's queue, owner or
 * administrator), drivers (Safety reads every driver; Dispatch reads cleared drivers only) and teams. Rows name the page and
 * a status, never what the page holds.
 */
@Injectable()
export class SearchService {
 constructor(private readonly db: DataSource, private readonly members: MemberListService, private readonly reviews: ReviewService) {}

 async search(user: User, q: string): Promise<{ groups: SearchGroup[] }> {
  const { text, digits } = searchTerms(q);
  if (text.replace(/\s/g, '').length < 3 && !digits) return { groups: [] };
  const dispatch = user.role === Role.SYSTEM_ADMIN || user.role === Role.DISPATCHER_MANAGER, safety = user.role === Role.SYSTEM_ADMIN || SAFETY.includes(user.role);
  const groups: SearchGroup[] = [], found = dispatch ? await this.members.suggest(q, 4, false) : null;
  if (found) {
   groups.push({ key: 'dispatchers', label: 'Dispatchers', items: (found.people as Record<string, unknown>[]).map(person => this.member(person)) });
   if (!digits) {
    const applications = await this.reviews.queue(user, { status: 'ALL', search: q.trim(), page: 1, pageSize: 3, sort: 'updatedAt', direction: 'DESC' });
    groups.push({ key: 'applications', label: 'Applications', items: applications.items.filter(item => item.fields?.firstName).map(item => ({ id: item.id,
     name: `${item.fields.firstName} ${item.fields.lastName ?? ''}`.trim(), meta: `Dispatcher application · ${item.id.slice(0, 8).toUpperCase()}`, status: status(APPLICATION_STATUS, item.status), href: `/onboarding/applications/${item.id}` })) });
   }
  }
  if (!digits && (dispatch || safety)) {
   const like = `%${escapeLike(text)}%`;
   const drivers: { id: string; firstName: string; lastName: string; driverType: string; licenseType: string | null; status: string }[] = await this.db.query(`SELECT id, "firstName", "lastName", "driverType", "licenseType", status FROM drivers
    WHERE lower("firstName" || ' ' || "lastName") LIKE $1 AND ($2::boolean OR status = 'CLEARED') ORDER BY CASE WHEN lower("firstName" || ' ' || "lastName") LIKE $3 THEN 0 ELSE 1 END, lower("firstName"), lower("lastName") LIMIT 3`,
    [like, safety, `${escapeLike(text)}%`]);
   groups.push({ key: 'drivers', label: 'Drivers', items: drivers.map(driver => {
    const name = `${driver.firstName} ${driver.lastName}`;
    return { id: driver.id, name, meta: [DRIVER_TYPE[driver.driverType] ?? driver.driverType, driver.licenseType ? LICENSE[driver.licenseType] ?? driver.licenseType : null].filter(Boolean).join(' · '),
     status: status(DRIVER_STATUS, driver.status), href: safety ? `/safety/drivers/${driver.id}` : `/dispatch/drivers?${new URLSearchParams({ status: 'ALL', search: name })}` };
   }) });
  }
  if (found && !digits) {
   groups.push({ key: 'teams', label: 'Teams', items: (found.teams as { id: string; name: string; mc: string; count: number }[]).map(team => ({ id: team.id, name: team.name, meta: `${team.mc} · ${team.count} ${team.count === 1 ? 'person' : 'people'}`, status: null, href: `/dispatch/teams/${team.id}` })) });
  }
  return { groups: groups.filter(group => group.items.length) };
 }

 /** A dispatcher, support or updater as the Dispatchers page names them. */
 private member(person: Record<string, unknown>): SearchItem {
  const leave = person.leave as { started?: boolean } | null, support = person.position === 'SUPPORT', kind = support ? (person.supportType === 'UPDATER' ? 'Updater' : 'Support') : 'Dispatcher';
  const meta = support ? `${kind} for ${person.wholeTeam ? `the whole ${person.wholeTeam}` : person.dispatcher ?? 'nobody yet'}` : [person.lead ? 'Dispatcher · team lead' : kind, person.team].filter(Boolean).join(' · ');
  const state: { label: string; tone: Tone } = person.status === 'LEFT' ? { label: 'Left', tone: 'neutral' } : person.lastDay ? { label: 'Leaving', tone: 'warning' }
   : leave?.started ? { label: 'On leave', tone: 'info' } : person.status === 'ONBOARDING' ? { label: 'Onboarding', tone: 'info' } : { label: 'Active', tone: 'success' };
  // What matched, unless their name did, as the Dispatchers box shows it.
  const matched = person.matched as { label: string; value: string } | null;
  return { id: person.id as string, name: `${person.firstName} ${person.lastName}`, meta: matched ? `${matched.label}: ${matched.value}` : meta, status: state, href: `/dispatch/dispatchers/${person.id}` };
 }
}

@Controller('search')
@Roles(Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER, Role.SAFETY_MANAGER, Role.SAFETY_LEAD, Role.SAFETY_STAFF)
class SearchController {
 constructor(private readonly service: SearchService) {}
 @Get() search(@Req() req: AuthRequest, @Query() query: SearchQueryDto) { return this.service.search(req.currentUser, query.q); }
}

@Module({ imports: [DispatchModule, OnboardingModule], controllers: [SearchController], providers: [SearchService] })
export class SearchModule {}
