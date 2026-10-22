'use client';
import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { Monitor } from 'lucide-react';
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
export function AppearanceSelect() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return <label className="flex min-h-11 items-center gap-2 rounded-xl border bg-background px-3"><Monitor aria-hidden="true" className="size-4 text-muted-foreground" /><span className="sr-only">Appearance</span><select disabled={!mounted} value={mounted ? theme : 'system'} onChange={event => setTheme(event.target.value)} className="max-w-28 cursor-pointer bg-transparent text-sm"><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label>;
}
