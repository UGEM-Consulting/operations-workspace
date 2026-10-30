'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, ImagePlus, RotateCw, Trash2 } from 'lucide-react';
import { Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { cn } from '@/lib/utils';
import { ApiError, errorMessage, mutate } from '@/lib/client-api';
import { imageForUpload, PhotoError } from '@/features/onboarding/photo';
import { documentLabels, workAuthorizationTypes, type DocumentKind } from '@/features/safety/types';
import type { DriverApplicationView } from './driver-application';

const segments: Record<DocumentKind, string> = { LICENSE: 'license', MEDICAL_CARD: 'medical-card', WORK_AUTHORIZATION: 'work-authorization' };
const hints: Record<DocumentKind, string> = { LICENSE: 'Photograph the front, then the back.', MEDICAL_CARD: 'Your DOT medical examiner’s certificate (all pages it has).',
  WORK_AUTHORIZATION: 'Any document that shows you can work in the US. You choose which one.' };
// Four pages per document, each small enough that all four fit one upload (the API allows 3.2 MB of photos in total).
const MAX_PAGES = 4, PAGE_BYTES = 760_000, PAGE_SIDE = 1800;
interface Page { id: number; file: File; url: string; rotation: number }
let nextPage = 0;
/** What a scanner holds that isn't saved yet, so the form can stop a submission that would leave it behind. */
export interface ScanDraft { pages: number; busy: boolean }
export const scannerId = (kind: DocumentKind) => `scan-${segments[kind]}`;

/**
 * Scans one document with the phone camera: take a photo of each page (or pick saved photos), turn any that came out
 * sideways, then save. The API removes photo metadata and combines the pages into one PDF. Saving again replaces it.
 */
export function DocumentScanner({ kind, view, required, error, onSaved, onEnded, onDraft }: { kind: DocumentKind; view: DriverApplicationView; required: boolean;
  error?: string; onSaved: (view: DriverApplicationView) => void; onEnded: (message: string) => void; onDraft: (kind: DocumentKind, draft: ScanDraft) => void }) {
  const current = view.documents?.find(document => document.kind === kind) ?? null;
  const [pages, setPages] = useState<Page[]>([]);
  const [scanning, setScanning] = useState(!current);
  const [subtype, setSubtype] = useState(current?.subtype ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''), [failed, setFailed] = useState(false), [announcement, setAnnouncement] = useState('');
  const camera = useRef<HTMLInputElement>(null), files = useRef<HTMLInputElement>(null);
  // Page previews still held, released when their page goes and when the scanner does.
  const urls = useRef(new Set<string>());
  useEffect(() => () => { for (const url of urls.current) URL.revokeObjectURL(url); }, []);
  useEffect(() => onDraft(kind, { pages: pages.length, busy }), [onDraft, kind, pages.length, busy]);
  // The form's error stays until what it asked for is done: the pages saved, or a scan made.
  const shownError = error && (pages.length > 0 || !current) ? error : '';
  const title = `${scannerId(kind)}-title`;
  function release(list: Page[]) { for (const page of list) { URL.revokeObjectURL(page.url); urls.current.delete(page.url); } }
  function add(list: FileList | null) {
    const chosen = [...(list ?? [])].filter(file => file.type.startsWith('image/')).slice(0, MAX_PAGES - pages.length);
    const added = chosen.map(file => { const url = URL.createObjectURL(file); urls.current.add(url); return { id: nextPage++, file, url, rotation: 0 }; });
    setPages(previous => [...previous, ...added]);
    setMessage(list && list.length > chosen.length ? `A document can have at most ${MAX_PAGES} pages.` : ''); setFailed(false);
  }
  function remove(page: Page) { release([page]); setPages(previous => previous.filter(item => item.id !== page.id)); }
  function stop() { release(pages); setPages([]); setScanning(false); setMessage(''); }
  async function save() {
    if (busy || !pages.length) return;
    if (kind === 'WORK_AUTHORIZATION' && !subtype) { setFailed(true); setMessage('Choose which document you’re scanning.'); return; }
    setBusy(true); setFailed(false); setMessage(''); setAnnouncement('');
    try {
      // One page at a time: decoding several full-size camera photos at once can exhaust an older phone's memory.
      const images: string[] = [];
      for (const page of pages) images.push(await imageForUpload(page.file, { maxSide: PAGE_SIDE, maxBytes: PAGE_BYTES, rotation: page.rotation }));
      const saved = await mutate<DriverApplicationView>(`driver/documents/${segments[kind]}`, 'POST', { pages: images, ...(kind === 'WORK_AUTHORIZATION' ? { subtype } : {}) });
      stop(); onSaved(saved); setAnnouncement(`${documentLabels[kind]} saved.`);
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'applicant-session') return onEnded(error.message);
      setFailed(true); setMessage(error instanceof PhotoError ? error.message : errorMessage(error, 'The scan wasn’t saved. Try again.'));
    } finally { setBusy(false); }
  }
  return <section id={scannerId(kind)} tabIndex={-1} aria-labelledby={title}
    className={cn('space-y-3 rounded-lg border p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring', shownError ? 'border-danger-border' : 'border-border')}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h3 id={title} className="font-medium">{documentLabels[kind]}{!required && <span className="font-normal text-muted-foreground"> (optional)</span>}</h3>
        <p className="text-sm text-muted-foreground">{hints[kind]}</p></div>
      {current && !scanning && <Button type="button" size="sm" variant="outline" onClick={() => { setScanning(true); setMessage(''); setAnnouncement(''); }}>Scan again</Button>}
    </div>
    {current && !scanning && <p className="flex flex-wrap items-center gap-2 text-sm"><CheckCircle2 aria-hidden="true" className="size-4 text-success" />
      Scanned {current.pageCount} {current.pageCount === 1 ? 'page' : 'pages'}{current.subtype ? ` · ${workAuthorizationTypes[current.subtype]}` : ''} · <LocalTime iso={current.createdAt} format="date" />
      <a className="text-primary underline" href={`/api/backend/driver/documents/${current.id}/file`} target="_blank" rel="noopener">View<span className="sr-only"> {documentLabels[kind].toLowerCase()}</span></a></p>}
    {scanning && <>
      {kind === 'WORK_AUTHORIZATION' && <Select label="Document" value={subtype} onChange={event => setSubtype(event.target.value)} placeholder="Choose a document" width="full"
        options={Object.entries(workAuthorizationTypes).map(([value, label]) => ({ value, label }))} />}
      {pages.length > 0 && <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label={`${documentLabels[kind]} pages`}>
        {pages.map((page, index) => <li key={page.id} className="space-y-2">
          <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of a photo the driver just took */}
            <img src={page.url} alt={`Page ${index + 1}`} className="max-h-full max-w-full object-contain transition-transform"
              // A quarter turn swaps width and height; shrinking keeps a page that filled the frame inside it.
              style={{ transform: `rotate(${page.rotation * 90}deg)${page.rotation % 2 ? ' scale(0.75)' : ''}` }} />
          </div>
          <div className="flex justify-center gap-3">
            <Button type="button" size="icon" variant="ghost" disabled={busy} onClick={() => setPages(previous => previous.map(item => item.id === page.id ? { ...item, rotation: (item.rotation + 1) % 4 } : item))}>
              <RotateCw aria-hidden="true" className="size-5" /><span className="sr-only">Turn page {index + 1}</span></Button>
            <Button type="button" size="icon" variant="ghost" className="text-danger" disabled={busy} onClick={() => remove(page)}>
              <Trash2 aria-hidden="true" className="size-5" /><span className="sr-only">Remove page {index + 1}</span></Button>
          </div>
        </li>)}
      </ol>}
      <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={event => { add(event.target.files); event.target.value = ''; }} />
      <input ref={files} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={event => { add(event.target.files); event.target.value = ''; }} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy || pages.length >= MAX_PAGES} onClick={() => camera.current?.click()}><Camera aria-hidden="true" className="size-4" />{pages.length ? 'Take another page' : 'Take photo'}</Button>
        <Button type="button" variant="ghost" disabled={busy || pages.length >= MAX_PAGES} onClick={() => files.current?.click()}><ImagePlus aria-hidden="true" className="size-4" />Choose photos</Button>
        {pages.length > 0 && <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : `Save ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`}</Button>}
        {current && <Button type="button" variant="ghost" disabled={busy} onClick={stop}>Cancel</Button>}
      </div>
      <p className="text-[13px] text-muted-foreground">Lay the document flat in good light, fill the frame and keep the text sharp. Use the turn button if a page is sideways.</p>
    </>}
    {shownError && <p className="text-sm text-danger">{shownError}</p>}
    <PendingHint pending={busy} />
    <Notice message={message} error={failed} />
    <p role="status" className="sr-only">{announcement}</p>
  </section>;
}
