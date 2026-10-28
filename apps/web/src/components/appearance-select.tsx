'use client';
import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
const themes = [{ value: 'light', label: 'Light', icon: Sun }, { value: 'dark', label: 'Dark', icon: Moon }, { value: 'system', label: 'System', icon: Monitor }];
export function AppearanceSelect() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const current = mounted ? themes.find(item => item.value === theme) ?? themes[2] : themes[2];
  return <DropdownMenu label={`Appearance: ${current.label}`} triggerIcon={current.icon} align="end"
    items={[{ heading: 'Appearance' }, ...themes.map(item => ({ label: item.label, icon: item.icon, checked: mounted && theme === item.value, onSelect: () => setTheme(item.value) }))]} />;
}
