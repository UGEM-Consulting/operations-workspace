import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { Role, User, UserStatus } from './user.entity';

/**
 * View-only access (Design System section 39, approved 2026-11-20). An administrator lets someone read another department
 * without changing their role, or gives a View only account the departments it may read; withFiles adds that department's
 * photos and documents. Grants live in staff_view_access and are read from PostgreSQL on every request, so taking one away
 * works at once. A role's own department is never granted: it already has more than a viewer.
 */
export type ViewDepartment = 'DISPATCH' | 'SAFETY';
export const VIEW_DEPARTMENTS: readonly ViewDepartment[] = ['DISPATCH', 'SAFETY'];
export interface ViewGrant { department: ViewDepartment; withFiles: boolean }
type Q = Pick<EntityManager, 'query'>;

/** The roles that already work in each department (with every page of it). */
const OWN: Record<ViewDepartment, Role[]> = {
  DISPATCH: [Role.SYSTEM_ADMIN, Role.DISPATCHER_MANAGER],
  SAFETY: [Role.SYSTEM_ADMIN, Role.SAFETY_MANAGER, Role.SAFETY_LEAD, Role.SAFETY_STAFF],
};
export const ownsDepartment = (role: Role, department: ViewDepartment) => OWN[department].includes(role);
/** The departments a role already works in, whose grants count for nothing (viewGrants and the two-step rule leave them out). */
export const ownDepartments = (role: Role) => VIEW_DEPARTMENTS.filter(department => ownsDepartment(role, department));

/** This person's grants, leaving out any for a department their role already has (a role changed since). */
export async function viewGrants(q: Q, user: Pick<User, 'id' | 'role'>): Promise<ViewGrant[]> {
  if (user.role === Role.SYSTEM_ADMIN) return [];
  const rows: ViewGrant[] = await q.query(`SELECT department, "withFiles" FROM staff_view_access WHERE "userId" = $1 ORDER BY department`, [user.id]);
  return rows.filter(row => !ownsDepartment(user.role, row.department));
}

/** The grant a view route needs, or 403. Checked from the database on every request. */
export async function requireView(q: Q, user: User, department: ViewDepartment, files = false): Promise<ViewGrant> {
  const grant = user.status === UserStatus.ACTIVE ? (await viewGrants(q, user)).find(row => row.department === department) : undefined;
  if (!grant || (files && !grant.withFiles)) throw new ForbiddenException();
  return grant;
}

/**
 * The grants an administrator asked for, checked against the role: never the role's own department, never for an
 * administrator, and at least one for View only. Returns them in a fixed order with each department once.
 */
export function checkedGrants(role: Role, requested: ViewGrant[]): ViewGrant[] {
  const grants = VIEW_DEPARTMENTS.map(department => requested.find(row => row.department === department)).filter((row): row is ViewGrant => !!row);
  if (grants.length !== requested.length) throw new BadRequestException('Choose each department once.');
  if (role === Role.SYSTEM_ADMIN && grants.length) throw new BadRequestException('Administrators already see every department.');
  if (grants.some(row => ownsDepartment(role, row.department))) throw new BadRequestException('Their role already includes that department.');
  if (role === Role.VIEWER && !grants.length) throw new BadRequestException('Choose at least one department they can view.');
  return grants;
}

/** Replaces someone's grants; returns what changed, as field names for the security event (never more). */
export async function saveGrants(q: Q, userId: string, actorId: string, grants: ViewGrant[]) {
  const before: ViewGrant[] = await q.query(`SELECT department, "withFiles" FROM staff_view_access WHERE "userId" = $1 FOR UPDATE`, [userId]);
  const added = grants.filter(row => !before.some(old => old.department === row.department)).map(row => row.department);
  const removed = before.filter(old => !grants.some(row => row.department === old.department)).map(row => row.department);
  const files = grants.filter(row => before.some(old => old.department === row.department && old.withFiles !== row.withFiles)).map(row => row.department);
  if (!added.length && !removed.length && !files.length) return null;
  await q.query(`DELETE FROM staff_view_access WHERE "userId" = $1 AND NOT (department = ANY($2::varchar[]))`, [userId, grants.map(row => row.department)]);
  for (const row of grants) {
    await q.query(`INSERT INTO staff_view_access ("userId", department, "withFiles", "grantedBy") VALUES ($1, $2, $3, $4)
     ON CONFLICT ("userId", department) DO UPDATE SET "withFiles" = EXCLUDED."withFiles", "grantedBy" = CASE WHEN staff_view_access."withFiles" = EXCLUDED."withFiles" THEN staff_view_access."grantedBy" ELSE EXCLUDED."grantedBy" END,
      "grantedAt" = CASE WHEN staff_view_access."withFiles" = EXCLUDED."withFiles" THEN staff_view_access."grantedAt" ELSE now() END`, [userId, row.department, row.withFiles, actorId]);
  }
  return { added, removed, files, withFiles: grants.filter(row => row.withFiles).map(row => row.department) };
}
