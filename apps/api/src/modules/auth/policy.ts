import { ForbiddenException, SetMetadata } from '@nestjs/common';
import { Role, User, UserStatus } from '../users/user.entity';
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
// section groups the sidebar; 'Account' items appear in the account menu instead of the main list.
const navigation = [
  { key: 'dashboard', href: '/dashboard', label: 'Overview', section: null, roles: STAFF },
  { key: 'onboarding', href: '/onboarding', label: 'Dispatcher onboarding', section: 'Onboarding', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'invitations', href: '/onboarding/invitations', label: 'Invitations', section: 'Onboarding', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'applications', href: '/onboarding/applications', label: 'Applications', section: 'Onboarding', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'documents', href: '/onboarding/documents', label: 'Documents', section: 'Onboarding', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'it', href: '/it/tasks', label: 'IT tasks', section: 'IT', roles: [Role.SYSTEM_ADMIN, Role.IT_SPECIALIST] },
  { key: 'settings', href: '/settings', label: 'Settings', section: 'Admin', roles: [Role.SYSTEM_ADMIN] },
  { key: 'security', href: '/account/security', label: 'Account security', section: 'Account', roles: STAFF },
];
export function accessFor(user: User) {
  return { navigation: navigation.filter(item => item.roles.includes(user.role)).map(({ key, href, label, section }) => ({ key, href, label, section })),
    landingPage: user.role === Role.DISPATCHER_MANAGER ? '/onboarding' : user.role === Role.IT_SPECIALIST ? '/it/tasks' : '/dashboard' };
}
export function requirePage(user: User, key: string): void {
  if (!accessFor(user).navigation.some(item => item.key === key)) throw new ForbiddenException();
}
// Future record controllers must load assignments from PostgreSQL, never from request bodies.
export function canAccessAssignedApplication(user: Pick<User, 'id' | 'role' | 'status'>, record: { assignedManagerId: string | null }): boolean {
  return user.status === UserStatus.ACTIVE && (user.role === Role.SYSTEM_ADMIN ||
    (user.role === Role.DISPATCHER_MANAGER && record.assignedManagerId === user.id));
}
