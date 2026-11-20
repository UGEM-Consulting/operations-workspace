import { ForbiddenException, SetMetadata } from '@nestjs/common';
import { Role, User, UserStatus } from '../users/user.entity';
import type { ViewDepartment, ViewGrant } from '../users/view-access';
import type { MfaStage } from './session';
export const PUBLIC = 'auth:public';
export const ROLES = 'auth:roles';
export const Public = () => SetMetadata(PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
export const MFA_STAGES = 'auth:mfa-stages';
/** Also admits a half-signed-in session at these stages. Routes still need @Roles; services re-read the pending state. */
export const AllowPendingMfa = (...stages: MfaStage[]) => SetMetadata(MFA_STAGES, stages);
/** The forced password-change step; same deny-by-default rules as AllowPendingMfa. */
export const AllowPendingPasswordChange = () => AllowPendingMfa('password');
export const STAFF = Object.values(Role);
/** Staff with a job in a department: everyone but View only accounts, which read and get no alerts (section 39). */
export const WORKING_STAFF = STAFF.filter(role => role !== Role.VIEWER);
// section groups the sidebar; 'Account' items appear in the account menu instead of the main list.
const navigation = [
  { key: 'dashboard', href: '/dashboard', label: 'Dashboard', section: null, roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER, Role.IT_SPECIALIST] },
  // A team lead sees only their own team; access follows the team their dispatcher record leads.
  { key: 'myteam', href: '/team', label: 'My team', section: null, roles: [Role.TEAM_LEAD] },
  // Cleared drivers waiting for a dispatcher in their teams, and the ones their teams work with.
  { key: 'teamdrivers', href: '/team/drivers', label: 'Drivers', section: null, roles: [Role.TEAM_LEAD] },
  // Announcements to the Telegram groups of the teams they lead (section 37).
  { key: 'teamannouncements', href: '/team/announcements', label: 'Announcements', section: null, roles: [Role.TEAM_LEAD] },
  { key: 'invitations', href: '/onboarding/invitations', label: 'Invitations', section: 'Onboarding', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'applications', href: '/onboarding/applications', label: 'Applications', section: 'Onboarding', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'documents', href: '/onboarding/documents', label: 'Documents', section: 'Onboarding', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'teams', href: '/dispatch/teams', label: 'Teams', section: 'Dispatch', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'dispatchers', href: '/dispatch/dispatchers', label: 'Dispatchers', section: 'Dispatch', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'promotions', href: '/dispatch/promotions', label: 'Promotions', section: 'Dispatch', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  // Drivers Safety has cleared, assigned to an MC and a dispatcher.
  { key: 'dispatchdrivers', href: '/dispatch/drivers', label: 'Drivers', section: 'Dispatch', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  // Announcements to teams' Telegram groups (section 37).
  { key: 'announcements', href: '/dispatch/announcements', label: 'Announcements', section: 'Dispatch', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  // Safety onboards drivers; every Safety role reads all driver records, and the service decides who changes what.
  { key: 'drivers', href: '/safety/drivers', label: 'Drivers', section: 'Safety', roles: [Role.SYSTEM_ADMIN, Role.SAFETY_MANAGER, Role.SAFETY_LEAD, Role.SAFETY_STAFF] },
  // Units (section 34): trucks and trailers with their owners, dates and permits; owner-operators' trucks among them.
  { key: 'units', href: '/safety/units', label: 'Units', section: 'Safety', roles: [Role.SYSTEM_ADMIN, Role.SAFETY_MANAGER, Role.SAFETY_LEAD, Role.SAFETY_STAFF] },
  // Driver license, medical card and work authorization scans that expired or expire soon.
  { key: 'expiring', href: '/safety/expiring', label: 'Expiring documents', section: 'Safety', roles: [Role.SYSTEM_ADMIN, Role.SAFETY_MANAGER, Role.SAFETY_LEAD, Role.SAFETY_STAFF] },
  // The consent forms drivers sign; the Safety manager publishes them.
  { key: 'consents', href: '/safety/consents', label: 'Forms and letters', section: 'Safety', roles: [Role.SYSTEM_ADMIN, Role.SAFETY_MANAGER, Role.SAFETY_LEAD, Role.SAFETY_STAFF] },
  { key: 'it', href: '/it/tasks', label: 'IT tasks', section: 'IT', roles: [Role.SYSTEM_ADMIN, Role.IT_SPECIALIST] },
  { key: 'lists', href: '/lists', label: 'Lists', section: 'Admin', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER, Role.IT_SPECIALIST] },
  { key: 'users', href: '/staff-accounts', label: 'Staff accounts', section: 'Admin', roles: [Role.SYSTEM_ADMIN] },
  // Telegram groups and where each alert goes (section 34).
  { key: 'telegram', href: '/telegram', label: 'Telegram', section: 'Admin', roles: [Role.SYSTEM_ADMIN] },
  // How long records are kept, what is due and the log (section 34).
  { key: 'retention', href: '/retention', label: 'Keeping records', section: 'Admin', roles: [Role.SYSTEM_ADMIN] },
  { key: 'settings', href: '/settings', label: 'Settings', section: 'Admin', roles: [Role.SYSTEM_ADMIN] },
  { key: 'security', href: '/account/security', label: 'Account security', section: 'Account', roles: STAFF },
];
// View-only access (section 39): each department's reading pages, in a section of their own marked view only. No counts.
const viewNavigation: Record<ViewDepartment, { key: string; href: string; label: string }[]> = {
  DISPATCH: [{ key: 'viewteams', href: '/view/dispatch/teams', label: 'Teams' }, { key: 'viewdispatchers', href: '/view/dispatch/dispatchers', label: 'Dispatchers' },
    { key: 'viewdispatchdrivers', href: '/view/dispatch/drivers', label: 'Drivers' }],
  SAFETY: [{ key: 'viewdrivers', href: '/view/safety/drivers', label: 'Drivers' }, { key: 'viewunits', href: '/view/safety/units', label: 'Units' },
    { key: 'viewexpiring', href: '/view/safety/expiring', label: 'Expiring documents' }],
};
const VIEW_SECTION: Record<ViewDepartment, string> = { DISPATCH: 'Dispatch · view only', SAFETY: 'Safety · view only' };
/** The menu and landing page; grants are the person's view-only departments (viewGrants), read by the caller. */
export function accessFor(user: User, grants: ViewGrant[] = []) {
  const views = grants.flatMap(grant => viewNavigation[grant.department].map(item => ({ ...item, section: VIEW_SECTION[grant.department] })));
  const own = navigation.filter(item => item.roles.includes(user.role)).map(({ key, href, label, section }) => ({ key, href, label, section }));
  // Account security stays last, after the departments they view.
  const items = [...own.filter(item => item.section !== 'Account'), ...views, ...own.filter(item => item.section === 'Account')];
  return { navigation: items, viewAccess: grants,
    landingPage: user.role === Role.VIEWER ? (views.find(item => item.key === 'viewdispatchers') ?? views[0])?.href ?? '/account/security' : user.role === Role.IT_SPECIALIST ? '/it/tasks' : user.role === Role.TEAM_LEAD ? '/team'
    : [Role.SAFETY_MANAGER, Role.SAFETY_LEAD, Role.SAFETY_STAFF].includes(user.role) ? '/safety/drivers' : '/dashboard' };
}
export function requirePage(user: User, key: string, grants: ViewGrant[] = []): void {
  if (!accessFor(user, grants).navigation.some(item => item.key === key)) throw new ForbiddenException();
}
// Future record controllers must load assignments from PostgreSQL, never from request bodies.
export function canAccessAssignedApplication(user: Pick<User, 'id' | 'role' | 'status'>, record: { assignedManagerId: string | null }): boolean {
  return user.status === UserStatus.ACTIVE && (user.role === Role.SYSTEM_ADMIN ||
    (user.role === Role.DISPATCHER_MANAGER && record.assignedManagerId === user.id));
}
