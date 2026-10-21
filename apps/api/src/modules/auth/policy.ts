import { ForbiddenException, SetMetadata } from '@nestjs/common';
import { Role, User, UserStatus } from '../users/user.entity';
export const PUBLIC = 'auth:public';
export const ROLES = 'auth:roles';
export const Public = () => SetMetadata(PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
export const STAFF = Object.values(Role);
const navigation = [
  { key: 'dashboard', href: '/dashboard', label: 'Overview', roles: STAFF },
  { key: 'onboarding', href: '/onboarding', label: 'Dispatcher onboarding', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'invitations', href: '/onboarding/invitations', label: 'Invitations', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'applications', href: '/onboarding/applications', label: 'Applications', roles: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER] },
  { key: 'it', href: '/it/tasks', label: 'IT tasks', roles: [Role.SYSTEM_ADMIN, Role.IT_SPECIALIST] },
  { key: 'settings', href: '/settings', label: 'Settings', roles: [Role.SYSTEM_ADMIN] },
];
export function accessFor(user: User) {
  return { navigation: navigation.filter(item => item.roles.includes(user.role)).map(({ key, href, label }) => ({ key, href, label })),
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
