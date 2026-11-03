'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PrivateImage } from '@/components/ui/private-image';
import { cn } from '@/lib/utils';

export interface ViewablePhoto { src: string; title: string; meta?: string; alt: string }

/**
 * A photo over the page, with arrows between someone's photos. A portal, since photos also show inside application forms. Only photos
 * this person may see are ever listed; the routes still check each one. No download, so ID photos aren't copied around.
 */
function PhotoModal({ photos, start, onClose }: { photos: ViewablePhoto[]; start: number; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const [index, setIndex] = useState(start), [zoomed, setZoomed] = useState(false);
  const photo = photos[index], previous = photos[index - 1], next = photos[index + 1];
  useEffect(() => {
    const dialog = ref.current, trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null, overflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = 'hidden';
    heading.current?.focus();
    return () => { dialog?.close(); document.body.style.overflow = overflow; trigger?.focus(); };
  }, []);
  const go = (to: number) => { setIndex(to); setZoomed(false); };
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return createPortal(<dialog ref={ref} aria-labelledby="photo-title" onCancel={event => { event.preventDefault(); onClose(); }} onChange={stop} onInput={stop} onSubmit={stop} onKeyDown={event => {
    event.stopPropagation();
    // At full size the arrow keys move around the photo, to read the edge of an ID.
    if (zoomed) return;
    if (event.key === 'ArrowLeft' && previous) go(index - 1);
    if (event.key === 'ArrowRight' && next) go(index + 1);
  }} className="fixed inset-0 m-auto h-dvh max-h-dvh w-full max-w-none flex-col overflow-hidden border-0 bg-card p-0 text-card-foreground shadow-lg backdrop:bg-overlay open:flex sm:h-[calc(100dvh-3rem)] sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100%-3rem)] sm:rounded-lg short:h-dvh! short:max-h-dvh! short:w-full! short:rounded-none!">
    <header className="flex shrink-0 items-center gap-2 border-b py-2 pl-4 pr-2 sm:gap-3 sm:py-3 sm:pl-5 sm:pr-4">
      <div className="min-w-0 flex-1"><h2 ref={heading} id="photo-title" tabIndex={-1} className="truncate text-[15px] font-semibold leading-[22px] outline-none">{photo.title}</h2>
        {photo.meta && <p className="truncate text-[13px] leading-5 text-muted-foreground">{photo.meta}</p>}</div>
      <Button type="button" variant="ghost" size="icon" className="max-lg:size-11" aria-label="Close photo" onClick={onClose}><X aria-hidden="true" className="size-5" /></Button>
    </header>
    <div className="min-h-0 flex-1 overflow-auto bg-muted p-3 [touch-action:pan-x_pan-y_pinch-zoom] sm:p-6">
      {/* Choosing the photo shows it at full size, for reading what's on an ID. */}
      <button type="button" aria-pressed={zoomed} aria-label={zoomed ? 'Fit the photo to the screen' : 'Show the photo at full size'} onClick={() => setZoomed(value => !value)} className={cn('mx-auto block rounded-md', zoomed ? 'w-max cursor-zoom-out' : 'h-full cursor-zoom-in')}>
        <PrivateImage key={photo.src} src={photo.src} alt={photo.alt} className={cn('mx-auto rounded-md', zoomed ? 'max-w-none' : 'h-full max-h-full max-w-full object-contain')} />
      </button>
    </div>
    {photos.length > 1 && <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-card px-4 py-3 sm:px-5">
      <Button type="button" variant="outline" disabled={!previous} onClick={() => go(index - 1)}><ArrowLeft aria-hidden="true" className="size-4" /><span className="sm:hidden">Back</span><span className="max-sm:sr-only">{previous ? previous.title.split(' · ')[0] : 'Back'}</span></Button>
      <span className="whitespace-nowrap text-[13px] font-medium text-muted-foreground">{index + 1} of {photos.length}</span>
      <Button type="button" variant="outline" disabled={!next} onClick={() => go(index + 1)}><span className="sm:hidden">Next</span><span className="max-sm:sr-only">{next ? next.title.split(' · ')[0] : 'Next'}</span><ArrowRight aria-hidden="true" className="size-4" /></Button>
    </div>}
  </dialog>, document.body);
}

/** Wraps a photo so choosing it opens the modal at that photo. */
export function PhotoButton({ photos, src, label, className, children }: { photos: ViewablePhoto[]; src: string; label: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" aria-label={label} onClick={() => setOpen(true)} className={cn('block cursor-zoom-in rounded-md focus-visible:outline-2', className)}>{children}</button>
    {open && <PhotoModal photos={photos} start={Math.max(photos.findIndex(photo => photo.src === src), 0)} onClose={() => setOpen(false)} />}
  </>;
}
