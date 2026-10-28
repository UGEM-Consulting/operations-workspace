'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Toast { id: number; tone: 'success' | 'danger'; title: string; description?: string }
type Show = (toast: Omit<Toast, 'id' | 'tone'> & { tone?: Toast['tone'] }) => void;
const ToastContext = createContext<Show>(() => {});
let next = 0;

/** A brief confirmation after an action, bottom right. Success clears after 5 seconds; errors stay until dismissed. */
export function useToast() { return useContext(ToastContext); }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts(list => list.filter(toast => toast.id !== id)), []);
  // Newest on top; at most three.
  const show = useCallback<Show>(toast => setToasts(list => [{ id: ++next, tone: 'success' as const, ...toast }, ...list].slice(0, 3)), []);
  return <ToastContext.Provider value={show}>
    {children}
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6">
      {toasts.map(toast => <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />)}
    </div>
  </ToastContext.Provider>;
}
function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    if (toast.tone !== 'success') return;
    const timer = window.setTimeout(onDismiss, 5000);
    return () => window.clearTimeout(timer);
  }, [toast.tone, onDismiss]);
  const Icon = toast.tone === 'success' ? CheckCircle2 : CircleAlert;
  return <div className="pointer-events-auto flex w-[380px] max-w-full items-start gap-3 rounded-md border border-border bg-popover py-3 pl-4 pr-2 text-popover-foreground shadow-lg">
    <Icon aria-hidden="true" className={cn('mt-0.5 size-5 shrink-0', toast.tone === 'success' ? 'text-success' : 'text-danger')} />
    <div className="min-w-0 flex-1"><p className="text-sm font-medium leading-[22px]">{toast.title}</p>{toast.description && <p className="text-[13px] leading-5 text-muted-foreground">{toast.description}</p>}</div>
    <button type="button" onClick={onDismiss} aria-label="Dismiss" className="grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"><X aria-hidden="true" className="size-4" /></button>
  </div>;
}
