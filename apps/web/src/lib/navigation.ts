/** A destination from /auth/me. `section` groups the sidebar; 'Account' items live in the account menu. */
export interface NavigationItem { key: string; href: string; label: string; section?: string | null }
export interface Crumb { label: string; href?: string }
/** A per-browser display preference (not identity): the server reads it so a collapsed sidebar renders collapsed. */
export const SIDEBAR_COOKIE = 'workspace-sidebar';
/** Work waiting for the signed-in person (GET /workspace/counts). */
export interface WorkspaceCounts { navigation: Record<string, number>; unreadNotifications: number | null }
const contains = (href: string, pathname: string) => pathname === href || pathname.startsWith(`${href}/`);
/** The most specific authorized destination for a path, so detail pages highlight their parent. */
export function activeNavigationItem<T extends NavigationItem>(items: readonly T[], pathname: string): T | undefined {
  return items.filter(({ href }) => contains(href, pathname)).sort((a, b) => b.href.length - a.href.length)[0];
}
/**
 * Breadcrumbs from the authorized destinations that contain the path, outermost first. A page below the deepest one
 * (a record) adds its own label; the last crumb is the current page and has no link.
 */
export function breadcrumbTrail(items: readonly NavigationItem[], pathname: string, pageLabel?: string | null): Crumb[] {
  const trail: Crumb[] = items.filter(({ href }) => contains(href, pathname)).sort((a, b) => a.href.length - b.href.length).map(({ label, href }) => ({ label, href }));
  if (trail.length && trail.at(-1)!.href !== pathname) trail.push({ label: pageLabel || 'Details' });
  return trail.map((crumb, index) => index === trail.length - 1 ? { label: crumb.label } : crumb);
}
/** Sidebar groups in /auth/me order; unlabelled items come first. */
export function navigationSections(items: readonly NavigationItem[]) {
  const sections: { label: string | null; items: NavigationItem[] }[] = [];
  for (const item of items) {
    if (item.section === 'Account') continue;
    const label = item.section ?? null;
    const section = sections.find(entry => entry.label === label) ?? sections[sections.push({ label, items: [] }) - 1];
    section.items.push(item);
  }
  return sections;
}
/** A queue URL from the current filters plus changes; any change goes back to page 1. Usable on server and client. */
// URL filter defaults for lists filtered in the browser. They live here, not in the 'use client' list components, so server
// pages can read them (a server import from a client module gets a reference, not the object).
export const INVITATION_DEFAULTS: Record<string, string> = { status: 'ALL', search: '' };
export const USER_DEFAULTS: Record<string, string> = { status: 'ALL', search: '' };
export function queueHref(path: string, filters: Record<string, string>, changes: Record<string, string>) {
  return `${path}?${new URLSearchParams({ ...filters, page: '1', ...changes })}`;
}
