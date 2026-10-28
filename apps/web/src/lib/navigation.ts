export interface NavigationItem { key: string; href: string; label: string }
/** The most specific authorized destination for a path, so detail pages highlight their parent. */
export function activeNavigationItem<T extends NavigationItem>(items: readonly T[], pathname: string): T | undefined {
  return items.filter(({ href }) => pathname === href || pathname.startsWith(`${href}/`)).sort((a, b) => b.href.length - a.href.length)[0];
}
