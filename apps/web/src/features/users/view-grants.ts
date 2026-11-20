/**
 * View-only departments (section 39) as the staff account dialog sends them. A role's own department is never sent: it
 * already has more than a viewer. The API checks every rule again.
 */
export type ViewDepartment = 'DISPATCH' | 'SAFETY';
export interface ViewGrant { department: ViewDepartment; withFiles: boolean }
export type ViewChoice = Record<ViewDepartment, { on: boolean; files: boolean }>;
const OWN: Record<ViewDepartment, string[]> = { DISPATCH: ['SYSTEM_ADMIN', 'DISPATCHER_MANAGER'], SAFETY: ['SYSTEM_ADMIN', 'SAFETY_MANAGER', 'SAFETY_LEAD', 'SAFETY_STAFF'] };
export const ownsDepartment = (role: string, department: ViewDepartment) => OWN[department].includes(role);
export const viewChoice = (grants: ViewGrant[] = []): ViewChoice => ({
  DISPATCH: { on: grants.some(grant => grant.department === 'DISPATCH'), files: grants.some(grant => grant.department === 'DISPATCH' && grant.withFiles) },
  SAFETY: { on: grants.some(grant => grant.department === 'SAFETY'), files: grants.some(grant => grant.department === 'SAFETY' && grant.withFiles) },
});
/** What to send for a role: the ticked departments its role doesn't already include. */
export const chosenGrants = (role: string, choice: ViewChoice): ViewGrant[] => role === 'SYSTEM_ADMIN' ? []
  : (['DISPATCH', 'SAFETY'] as const).filter(department => choice[department].on && !ownsDepartment(role, department)).map(department => ({ department, withFiles: choice[department].files }));
/** "Dispatch, Safety" for the Also views column. */
export const viewLabel = (grants: ViewGrant[] = []) => grants.map(grant => grant.department === 'DISPATCH' ? 'Dispatch' : 'Safety').join(', ');
