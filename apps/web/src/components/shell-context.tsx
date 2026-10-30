'use client';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

/** Return false to keep the person on the page (for example to confirm discarding unsaved changes). */
export type LeaveGuard = (href: string) => boolean;
interface ShellState { pageLabel: string | null; setPageLabel: (label: string | null, path?: string) => void; guard: { current: LeaveGuard | null } }
const ShellContext = createContext<ShellState | null>(null);

export function ShellProvider({ children }: { children: ReactNode }) {
  const [label, setLabel] = useState<{ path: string; label: string | null } | null>(null);
  const pathname = usePathname();
  const guard = useRef<LeaveGuard | null>(null);
  // A label belongs to the page that set it, so it never leaks into the next page's breadcrumbs.
  const pageLabel = label?.path === pathname ? label.label : null;
  const setPageLabel = useCallback((next: string | null, path = window.location.pathname) => setLabel(previous => {
    return previous?.path === path && previous.label === next ? previous : { path, label: next };
  }), []);
  const value = useMemo(() => ({ pageLabel, setPageLabel, guard }), [pageLabel, setPageLabel]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
export function useShell() {
  const context = useContext(ShellContext);
  if (!context) throw new Error('useShell must be used inside the workspace shell');
  return context;
}
/**
 * Names a record page (an applicant, an IT request) as the last breadcrumb. Renders nothing. A layout effect sets it
 * before the browser paints, so a client navigation never shows the generic label first; the shell leaves the crumb
 * blank until hydration for the same reason.
 */
export function PageCrumb({ label }: { label: string }) {
  const { setPageLabel } = useShell();
  const pathname = usePathname();
  useLayoutEffect(() => { setPageLabel(label, pathname); return () => setPageLabel(null, pathname); }, [label, pathname, setPageLabel]);
  return null;
}
/** Asks before the shell's breadcrumb and sidebar links leave this page. */
export function useLeaveGuard(guard: LeaveGuard | null) {
  const { guard: ref } = useShell();
  useEffect(() => { ref.current = guard; return () => { ref.current = null; }; }, [guard, ref]);
}
/** onClick for shell links: lets the page's guard keep the person here. */
export function useGuardedLink() {
  const { guard } = useShell();
  return (href: string) => (event: React.MouseEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    if (guard.current && !guard.current(href)) event.preventDefault();
  };
}
