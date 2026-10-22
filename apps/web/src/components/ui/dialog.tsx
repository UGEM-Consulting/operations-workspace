'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './button';

/** Native modal semantics, focus restoration and one consistent discard guard. */
export function Dialog({ open, onClose, title, description, busy = false, protectChanges = true, closeLabel = 'Cancel', actions, children }: {
  open: boolean; onClose: () => void; title: string; description?: string;
  busy?: boolean; protectChanges?: boolean; closeLabel?: string; actions?: ReactNode; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = 'hidden';
    const first = dialog?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
    (first ?? heading.current)?.focus();
    return () => { dialog?.close(); document.body.style.overflow = overflow; trigger?.focus(); };
  }, [open]);
  useEffect(() => { if (discard) keep.current?.focus(); }, [discard]);
  useEffect(() => {
    if (!open || !dirty || !protectChanges) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [open, dirty, protectChanges]);
  function close() {
    if (busy) return;
    if (dirty && protectChanges) { setDiscard(true); return; }
    onClose();
  }
  if (!open) return null;
  return <dialog ref={ref} aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined}
    onCancel={event => { event.preventDefault(); close(); }}
    className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-2xl border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-black/60">
    <div className="flex items-start justify-between gap-4 border-b p-5 sm:p-6">
      <div><h2 ref={heading} tabIndex={-1} id={`${id}-title`} className="text-xl font-semibold outline-none">{title}</h2>{description && <p id={`${id}-description`} className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>}</div>
      <Button type="button" variant="ghost" size="icon" className="shrink-0" disabled={busy} aria-label={`Close ${title.toLowerCase()}`} onClick={close}><X aria-hidden="true" className="size-5" /></Button>
    </div>
    <div className="p-5 sm:p-6" aria-busy={busy}>
      {discard && <div role="alert" className="mb-5 space-y-3 rounded-xl border border-warning bg-warning-background p-4 text-sm"><p className="font-semibold">Discard unsaved changes?</p><p>Your changes have not been saved.</p><div className="flex flex-wrap gap-3"><Button ref={keep} type="button" variant="outline" onClick={() => { setDiscard(false); heading.current?.focus(); }}>Keep editing</Button><Button type="button" variant="destructive" onClick={onClose}>Discard changes</Button></div></div>}
      <fieldset disabled={busy || discard} className="min-w-0" onChangeCapture={() => setDirty(true)}>
        {children}
      </fieldset>
    </div>
    <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-card p-5 sm:px-6"><Button type="button" variant="outline" disabled={busy} onClick={close}>{closeLabel}</Button><fieldset disabled={busy || discard} className="min-w-0">{actions}</fieldset></div>
  </dialog>;
}
