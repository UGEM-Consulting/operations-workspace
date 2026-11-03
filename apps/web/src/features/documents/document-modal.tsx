'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DescriptionList } from '@/components/ui/description-list';
import { Disclosure } from '@/components/ui/disclosure';
import { Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { downloadBlob, PdfPages, PrintButton, usePdf, type PdfFailure, type PdfFile } from './pdf';

const failures: Record<PdfFailure, string> = {
  session: 'Your session has ended. Close this, sign in or verify again, then reopen the document.',
  gone: 'This document is no longer available here. Close this and reload the page.',
  other: 'We couldn’t show this document. Check your connection and try again.',
};

/**
 * A document over the page: the header with zoom, Print and Download, the pages, and an optional panel beside them (below them under
 * 1024px, or beside them on a phone turned sideways). The dialog sits in a portal, because these open from inside the application form, and
 * nothing typed here reaches that form. `floating` is anything that follows the pointer: only what's inside a modal dialog shows above it.
 */
export function DocumentModal({ title, meta, file, failure, reload, zoom, onZoom, pages, panel, panelGrows = false, panelDesktopOnly = false, floating, onClose, closeLabel = 'Close document', busy = false }: {
  title: string; meta?: ReactNode; file: PdfFile | null; failure: PdfFailure | null; reload: () => void; zoom: number; onZoom: (zoom: number) => void;
  pages: ReactNode; panel?: ReactNode; panelGrows?: boolean; panelDesktopOnly?: boolean; floating?: ReactNode; onClose: () => void; closeLabel?: string; busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
  // Only ever opened by a click, so this never renders on the server.
  useEffect(() => {
    const dialog = ref.current, trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null, overflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = 'hidden';
    heading.current?.focus();
    return () => { dialog?.close(); document.body.style.overflow = overflow; trigger?.focus(); };
  }, []);
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return createPortal(<dialog ref={ref} aria-labelledby="document-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onChange={stop} onInput={stop} onSubmit={stop} onKeyDown={stop}
    className="fixed inset-0 m-auto h-dvh max-h-dvh w-full max-w-none flex-col overflow-hidden border-0 bg-card p-0 text-card-foreground shadow-lg backdrop:bg-overlay open:flex sm:h-[calc(100dvh-3rem)] sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100%-3rem)] sm:rounded-lg short:h-dvh! short:max-h-dvh! short:w-full! short:rounded-none!">
    <header className="flex shrink-0 items-center gap-2 border-b py-2 pl-4 pr-2 short:py-0.5 sm:gap-3 sm:py-3 sm:pl-5 sm:pr-4">
      <div className="min-w-0 flex-1"><h2 ref={heading} id="document-title" tabIndex={-1} className="truncate text-[15px] font-semibold leading-[22px] outline-none">{title}</h2>
        {meta && <p className="truncate text-[13px] leading-5 text-muted-foreground">{meta}</p>}</div>
      <div className="hidden items-center gap-1 lg:flex">
        <Button type="button" variant="ghost" size="icon" aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => onZoom(Math.max(0.5, zoom - 0.25))}><ZoomOut aria-hidden="true" className="size-4" /></Button>
        <span aria-live="polite" className="min-w-11 text-center text-[13px] font-medium tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
        <Button type="button" variant="ghost" size="icon" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => onZoom(Math.min(3, zoom + 0.25))}><ZoomIn aria-hidden="true" className="size-4" /></Button>
        <span aria-hidden="true" className="mx-2 h-6 w-px bg-border" />
        {/* Phones print from the downloaded file: a page can't print a PDF for them. */}
        <PrintButton file={file} />
      </div>
      <Button type="button" variant="ghost" size="sm" disabled={!file} aria-label="Download" onClick={() => file && downloadBlob(file.blob, file.filename)} className="max-lg:size-11 max-lg:px-0"><Download aria-hidden="true" className="size-4" /><span className="hidden lg:inline">Download</span></Button>
      <span aria-hidden="true" className="mx-1 hidden h-6 w-px bg-border lg:block" />
      <Button type="button" variant="ghost" size="icon" className="max-lg:size-11" aria-label={closeLabel} disabled={busy} onClick={onClose}><X aria-hidden="true" className="size-5" /></Button>
    </header>
    <div className={cn('flex min-h-0 flex-1 flex-col short:flex-row lg:grid', panel ? 'lg:grid-cols-[minmax(0,1fr)_400px]' : 'lg:grid-cols-[minmax(0,1fr)]')}>
      <div className={cn('flex min-h-0 min-w-0 flex-col bg-muted', panelGrows ? (failure ? 'shrink-0 short:max-lg:w-1/2' : 'shrink-0 max-md:hidden short:hidden! md:h-[28dvh] lg:h-auto') : 'flex-1')}>
        {failure ? <div className="m-auto w-full max-w-md p-4"><Alert tone="danger" title="Document not shown" action={failure === 'other' ? <Button type="button" size="sm" variant="outline" onClick={reload}><RotateCw aria-hidden="true" className="size-4" />Try again</Button> : undefined}><p>{failures[failure]}</p></Alert></div>
          : file ? pages : <div className="mx-auto w-full max-w-[816px] space-y-4 p-4" role="status" aria-label="Loading the document"><Skeleton className="aspect-[17/22] w-full bg-card" /></div>}
      </div>
      {panel && <aside className={cn('flex min-h-0 flex-col border-t bg-card shadow-[0_-6px_16px_rgba(0,0,0,.08)] lg:w-auto lg:border-l lg:border-t-0 lg:shadow-none', panelGrows ? 'flex-1 max-md:border-t-0 max-md:shadow-none short:border-t-0! short:shadow-none!' : 'short:w-1/2 short:shrink-0 short:border-l short:border-t-0 short:shadow-none', panelDesktopOnly && 'max-lg:hidden')}>{panel}</aside>}
    </div>
    {floating}
  </dialog>, document.body);
}

export interface ViewableDocument {
  /** The file route, under the BFF. */ url: string; title: string; meta?: ReactNode; fallbackName?: string; /** Generated copies end with a certificate page. */ certificate?: boolean;
  /** Shown beside the pages. */ record?: { label: string; value: ReactNode }[]; details?: { label: string; value: ReactNode }[];
}
/** Read a document, with arrows between someone's documents when there's more than one. */
export function DocumentViewer({ documents, index: first = 0, onClose }: { documents: ViewableDocument[]; index?: number; onClose: () => void }) {
  const [index, setIndex] = useState(first), [zoom, setZoom] = useState(1);
  const doc = documents[index], { file, failure, reload } = usePdf({ url: doc.url, fallbackName: doc.fallbackName ?? 'document.pdf' });
  const many = documents.length > 1, previous = documents[index - 1], next = documents[index + 1];
  const showPanel = many || !!doc.record?.length, pageCount = file?.sizes.length;
  const meta = pageCount ? <>{doc.meta}{doc.meta ? ' · ' : ''}{pageCount} {pageCount === 1 ? 'page' : 'pages'}{doc.certificate && <span className="max-lg:hidden"> with the signing certificate</span>}</> : doc.meta;
  const panel = showPanel ? <>
    {/* On a phone the page gets the room; only the arrows stay. */}
    {!!doc.record?.length && <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 max-lg:hidden lg:p-5">
      <h3 className="text-[17px] font-semibold leading-6">Signing record</h3>
      <DescriptionList layout="rows" items={doc.record} />
      {!!doc.details?.length && <Disclosure title="Technical details"><DescriptionList layout="rows" items={doc.details} /></Disclosure>}
    </div>}
    {many && <div className="mt-auto flex items-center justify-between gap-2 border-t p-3 lg:p-4">
      <Button type="button" variant="outline" size="sm" disabled={!previous} onClick={() => setIndex(index - 1)}><ChevronLeft aria-hidden="true" className="size-4" />Previous</Button>
      <span className="text-[13px] text-muted-foreground">{index + 1} of {documents.length}</span>
      <Button type="button" variant="outline" size="sm" disabled={!next} onClick={() => setIndex(index + 1)}><span className="max-w-32 truncate max-lg:hidden">{next?.title ?? 'Next'}</span><span className="lg:hidden">Next</span><ChevronRight aria-hidden="true" className="size-4" /></Button>
    </div>}
  </> : undefined;
  return <DocumentModal title={doc.title} meta={meta} file={file} failure={failure} reload={reload} zoom={zoom} onZoom={setZoom} onClose={onClose} panel={panel} panelDesktopOnly={!many}
    pages={file && <PdfPages key={doc.url} file={file} zoom={zoom} className="flex-1" />} />;
}
/** A button that opens the viewer; usable from server-rendered pages. */
export function ViewDocumentButton({ documents, index = 0, children, label, variant = 'ghost', size = 'sm', className }: { documents: ViewableDocument[]; index?: number; children: ReactNode; label?: string;
  variant?: 'ghost' | 'outline' | 'link' | 'default'; size?: 'sm' | 'default' | 'icon'; className?: string }) {
  const [open, setOpen] = useState(false);
  return <><Button type="button" variant={variant} size={size} className={className} aria-label={label} onClick={() => setOpen(true)}>{children}</Button>
    {open && <DocumentViewer documents={documents} index={index} onClose={() => setOpen(false)} />}</>;
}
/**
 * On a phone a step has the whole screen; while `peek` is on this shows the page instead, with one way back. Wide screens have room for both, so they keep
 * the panel. The panel stays mounted either way, so a signature in the pad is still there, and still matches what's held, on the way back.
 */
export function PeekPanel({ peek, label, onBack, children }: { peek: boolean; label: string; onBack: () => void; children: ReactNode }) {
  return <>{peek && <div className="shrink-0 bg-card p-4 lg:hidden"><Button type="button" size="lg" className="w-full" onClick={onBack}>{label}</Button></div>}<div className={peek ? 'hidden min-h-0 flex-1 flex-col lg:flex' : 'contents'}>{children}</div></>;
}
