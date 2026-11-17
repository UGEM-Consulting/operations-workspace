'use client';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Check, Columns3, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// The Dispatchers table's Columns menu (GlanceColumnsScreen, section 36): what shows is remembered on this browser only. Name
// and Status always show. A hidden column is hidden with CSS (globals.css, data-hidden-columns), so the server renders the
// table once and nothing moves when the choice loads.
export const GLANCE_COLUMNS = [
  { key: 'mc', label: 'MC' }, { key: 'team', label: 'Team' }, { key: 'drivers', label: 'Drivers' },
  { key: 'contact', label: 'Contact', description: 'RingCentral number with extension, company email and Telegram.' },
  { key: 'helpers', label: 'Helped by', description: 'Their supports and updaters.' },
  { key: 'loadBoards', label: 'Load boards', description: 'DAT and Truckstop accounts they use. Never sign-ins.', off: true },
  { key: 'title', label: 'Job title', off: true }, { key: 'since', label: 'Since', description: 'When they started at their MC.', off: true },
] as const;
const DEFAULT_HIDDEN = GLANCE_COLUMNS.filter(column => 'off' in column).map(column => column.key).join(' ');
const STORAGE_KEY = 'dispatchers.hiddenColumns';
const listeners = new Set<() => void>();
// Browser storage can be missing or refuse (private windows, blocked site data): the defaults apply then.
function readHidden() {
  try { const saved = window.localStorage.getItem(STORAGE_KEY); return saved === null ? DEFAULT_HIDDEN : saved; } catch { return DEFAULT_HIDDEN; }
}
function writeHidden(value: string) {
  try { if (value === DEFAULT_HIDDEN) window.localStorage.removeItem(STORAGE_KEY); else window.localStorage.setItem(STORAGE_KEY, value); } catch { /* kept for this page only */ }
  memory = value; listeners.forEach(listener => listener());
}
let memory: string | null = null;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const useHidden = () => useSyncExternalStore(subscribe, () => (memory ??= readHidden()), () => DEFAULT_HIDDEN);
const KEYS: readonly string[] = GLANCE_COLUMNS.map(column => column.key);

/** The table's wrapper: carries the hidden columns for the CSS that hides them, only on tabs that offer the Columns menu. */
export function ColumnsView({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const hidden = useHidden();
  return <div data-hidden-columns={enabled ? hidden : undefined}>{children}</div>;
}

/** Columns, next to Export: a menu of checkboxes that stays open while choosing. */
export function ColumnsMenu() {
  // A key a later version no longer offers is dropped, so the count stays right.
  const hidden = useHidden().split(' ').filter(key => KEYS.includes(key));
  const toggle = (key: string) => writeHidden((hidden.includes(key) ? hidden.filter(item => item !== key) : [...hidden, key]).sort().join(' '));
  const shown = GLANCE_COLUMNS.length + 2 - hidden.length;
  const item = (column: typeof GLANCE_COLUMNS[number]) => <Menu.CheckboxItem key={column.key} checked={!hidden.includes(column.key)} onSelect={event => { event.preventDefault(); toggle(column.key); }}
    className="flex cursor-pointer gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent">
    <span aria-hidden="true" className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border border-input data-[state=checked]:border-primary data-[state=checked]:bg-primary">
      <Menu.ItemIndicator><Check className="size-3 text-primary-foreground" strokeWidth={3} /></Menu.ItemIndicator></span>
    <span className="grid"><span>{column.label}</span>{'description' in column && <span className="text-[13px] leading-[18px] text-muted-foreground">{column.description}</span>}</span>
  </Menu.CheckboxItem>;
  return <Menu.Root>
    <Menu.Trigger asChild><Button variant="outline" size="sm"><Columns3 aria-hidden="true" />Columns</Button></Menu.Trigger>
    <Menu.Portal><Menu.Content align="end" sideOffset={6} className="z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg">
      <div className="px-4 pt-3 pb-2"><p className="font-semibold">Columns</p><p className="text-[13px] leading-[18px] text-muted-foreground">Choose what the table shows. Remembered on this browser. Name and Status always show.</p></div>
      <div className="grid gap-0.5 px-2 pb-2">{GLANCE_COLUMNS.filter(column => !('off' in column)).map(item)}</div>
      <Menu.Label className="border-t border-border px-4 pt-2.5 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Off by default</Menu.Label>
      <div className="grid gap-0.5 px-2 pb-2">{GLANCE_COLUMNS.filter(column => 'off' in column).map(item)}</div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 text-[13px] text-muted-foreground">
        <span>{shown} of {GLANCE_COLUMNS.length + 2} shown</span>
        <Menu.Item onSelect={event => { event.preventDefault(); writeHidden(DEFAULT_HIDDEN); }} className="cursor-pointer rounded-md px-2 py-1 font-medium text-foreground outline-none data-[highlighted]:bg-accent">Reset to default</Menu.Item>
      </div>
    </Menu.Content></Menu.Portal>
  </Menu.Root>;
}

/** A small icon button that copies a value, for table cells. */
/** One polite status region for every copy button on the page, made on first use, so a long table doesn't add one per cell. */
function announce(message: string) {
  let region = document.getElementById('copy-status');
  if (!region) {
    region = Object.assign(document.createElement('div'), { id: 'copy-status', className: 'sr-only' });
    region.setAttribute('role', 'status'); document.body.append(region);
  }
  region.textContent = message;
}

export function CopyIcon({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    try { await navigator.clipboard.writeText(text); setCopied(true); announce(`${label} copied`); timer.current = setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); announce(`The ${label} couldn’t be copied`); }
  }
  const Icon = copied ? Check : Copy;
  return <button type="button" aria-label={`Copy ${label}`} title={`Copy ${label}`} onClick={() => void copy()}
      className={cn('inline-grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2', copied && 'text-success')}><Icon aria-hidden="true" className="size-3.5" /></button>;
}
