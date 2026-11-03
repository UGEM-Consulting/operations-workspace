'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Printer, RotateCw } from 'lucide-react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { Button } from '@/components/ui/button';

/**
 * PDFs are drawn by the page with pdf.js, because phones often can't show a PDF inside a page. The library loads only when a
 * document opens. Documents come from the same-origin BFF; scripts inside a PDF never run (isEvalSupported off, no forms).
 */
async function pdfjs() {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (!lib.GlobalWorkerOptions.workerPort) lib.GlobalWorkerOptions.workerPort = new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' });
  return lib;
}

export interface PdfFile { pdf: PDFDocumentProxy; sizes: { width: number; height: number }[]; blob: Blob; filename: string }
export type PdfSource = { url: string; fallbackName: string } | { file: File };
export type PdfFailure = 'session' | 'gone' | 'other';

/** Loads a document; `reload` tries again. `file` is null until it's ready, and `failure` says why it isn't. */
export function usePdf(source: PdfSource | null) {
  const [attempt, setAttempt] = useState(0), [result, setResult] = useState<{ key: string; file?: PdfFile; failure?: PdfFailure } | null>(null);
  const key = `${attempt}:${!source ? '' : 'url' in source ? source.url : `${source.file.name}:${source.file.size}`}`;
  useEffect(() => {
    if (!source) return;
    let cancelled = false, opened: PDFDocumentProxy | null = null;
    (async () => {
      let blob: Blob, filename: string;
      if ('url' in source) {
        const response = await fetch(source.url, { credentials: 'same-origin' });
        if (!response.ok) { if (!cancelled) setResult({ key, failure: response.status === 401 ? 'session' : response.status === 404 ? 'gone' : 'other' }); return; }
        blob = await response.blob();
        filename = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? source.fallbackName;
      } else { blob = source.file; filename = source.file.name; }
      const lib = await pdfjs();
      const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false, verbosity: 0 }).promise;
      opened = pdf;
      const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, index) => pdf.getPage(index + 1)));
      const sizes = pages.map(page => { const view = page.getViewport({ scale: 1 }); return { width: view.width, height: view.height }; });
      if (cancelled) { void pdf.destroy(); return; }
      setResult({ key, file: { pdf, sizes, blob, filename } });
    })().catch(() => { if (!cancelled) setResult({ key, failure: 'other' }); });
    return () => { cancelled = true; void opened?.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key names the source
  }, [key]);
  const current = result?.key === key ? result : null;
  return { file: current?.file ?? null, failure: current?.failure ?? null, reload: useCallback(() => setAttempt(value => value + 1), []) };
}

// Past these a browser may refuse a canvas without saying so (Safari's limit is about 16.7 million pixels).
const MAX_CANVAS_PIXELS = 16_000_000, MAX_CANVAS_SIDE = 4096;
function canvasScale(width: number, height: number) { return Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)), MAX_CANVAS_SIDE / Math.max(width, height)); }

function PdfPage({ pdf, number, width, height, scale, root, text, onDrawn, children }: { pdf: PDFDocumentProxy; number: number; width: number; height: number; scale: number; root: RefObject<HTMLElement | null>; text: boolean; onDrawn: (page: number, drawn: boolean) => void; children?: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null), box = useRef<HTMLDivElement>(null), words = useRef<HTMLDivElement>(null), [near, setNear] = useState(false), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => setNear(entries[entries.length - 1].isIntersecting), { root: root.current, rootMargin: '800px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    // A long document would otherwise keep every page's bitmap, which phones run out of memory for.
    if (!near) { element.width = 0; element.height = 0; words.current?.replaceChildren(); return; }
    let task: RenderTask | null = null, cancelled = false, cancelText: (() => void) | null = null;
    (async () => {
      const page = await pdf.getPage(number);
      if (cancelled) return;
      const pixels = Math.min(window.devicePixelRatio || 1, 2), full = page.getViewport({ scale: scale * pixels }), viewport = page.getViewport({ scale: scale * pixels * canvasScale(full.width, full.height) });
      element.width = Math.floor(viewport.width); element.height = Math.floor(viewport.height);
      task = page.render({ canvasContext: element.getContext('2d')!, viewport });
      await task.promise;
      if (cancelled) return;
      setFailed(false); onDrawn(number, true);
      if (!text || !words.current) return;
      // Invisible text over the picture, for screen readers and selecting. A scanned page has none; the picture alone still counts as shown.
      const container = words.current, { TextLayer } = await pdfjs();
      if (cancelled) return;
      container.replaceChildren();
      container.style.setProperty('--scale-factor', String(scale));
      const layer = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport: page.getViewport({ scale }) });
      cancelText = () => layer.cancel();
      await layer.render().catch(() => undefined);
    })().catch(() => { if (!cancelled) { setFailed(true); onDrawn(number, false); } });
    return () => { cancelled = true; task?.cancel(); cancelText?.(); };
  }, [near, pdf, number, scale, attempt, text, onDrawn]);
  return <div ref={box} data-pdf-page={number} role="group" aria-label={`Page ${number}`} className="relative shrink-0 overflow-clip bg-white shadow-sm" style={{ width: width * scale, height: height * scale }}>
    <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 size-full" />
    {text && <div ref={words} className="textLayer" />}
    {failed && <div role="alert" className="absolute inset-0 grid place-content-center justify-items-center gap-2 p-4 text-center text-sm text-neutral-900">This page couldn’t be shown.
      <Button type="button" size="sm" variant="outline" className="border-neutral-400 bg-white text-neutral-900 hover:bg-neutral-100" onClick={() => setAttempt(value => value + 1)}><RotateCw aria-hidden="true" className="size-4" />Try again</Button></div>}
    {children}
  </div>;
}

/**
 * Every page in one scrolling column, fitted to the width and multiplied by `zoom`. `overlay` draws on a page. `onProgress` reports the
 * page in view and whether the last page has been reached and drawn with no page failing; `focus` scrolls to a place on a page. `text` adds
 * the selectable text layer.
 */
export function PdfPages({ file, zoom = 1, overlay, onProgress, focus, text = true, className = '', maxWidth = 816 }: { file: PdfFile; text?: boolean; zoom?: number; overlay?: (page: number, width: number, height: number) => ReactNode;
  onProgress?: (page: number, atEnd: boolean) => void; focus?: { page: number; y: number } | null; className?: string; maxWidth?: number }) {
  const scroller = useRef<HTMLDivElement>(null), [available, setAvailable] = useState(0), [drawn, setDrawn] = useState<Record<number, boolean>>({});
  const onDrawn = useCallback((page: number, ok: boolean) => setDrawn(current => current[page] === ok ? current : { ...current, [page]: ok }), []);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const report = useCallback(() => {
    const element = scroller.current;
    if (!element || !onProgress) return;
    const pages = [...element.querySelectorAll<HTMLElement>('[data-pdf-page]')];
    if (!pages.length) return;
    const view = element.getBoundingClientRect(), middle = view.top + view.height / 2;
    const current = pages.find(page => page.getBoundingClientRect().bottom >= middle) ?? pages[pages.length - 1];
    const last = pages[pages.length - 1].getBoundingClientRect();
    // Reached once most of the last page has been on screen, or its bottom has, for a page taller than the view. A blank page is not read.
    const shown = drawn[pages.length] === true && !Object.values(drawn).includes(false);
    onProgress(Number(current.dataset.pdfPage), shown && (last.bottom <= view.bottom + 4 || view.bottom - last.top >= Math.min(last.height, view.height) * 0.6));
  }, [onProgress, drawn]);
  useEffect(() => { report(); }, [report, available, zoom, file]);
  const width = Math.max(available - 32, 200), widest = Math.max(...file.sizes.map(size => size.width));
  const base = Math.min(width, maxWidth) / widest, scale = base * zoom;
  useEffect(() => {
    const element = scroller.current;
    if (!element || !focus || !available) return;
    const page = element.querySelector<HTMLElement>(`[data-pdf-page="${focus.page}"]`);
    if (page) element.scrollTo({ top: page.offsetTop + page.offsetHeight * focus.y - element.clientHeight * 0.35 - element.offsetTop, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [focus, available, scale]);
  return <div ref={scroller} tabIndex={0} aria-label="Document pages" onScroll={report} className={`min-h-0 overflow-auto bg-muted outline-none focus-visible:outline-2 focus-visible:outline-ring [touch-action:pan-x_pan-y_pinch-zoom] ${className}`}>
    <div className="mx-auto flex w-fit min-w-full flex-col items-center gap-4 p-4">
      {available > 0 && file.sizes.map((size, index) => <PdfPage key={index} pdf={file.pdf} number={index + 1} width={size.width} height={size.height} scale={scale} root={scroller} text={text} onDrawn={onDrawn}>
        {overlay?.(index + 1, size.width * scale, size.height * scale)}
      </PdfPage>)}
    </div>
  </div>;
}

/** Saves the file with its own name. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
/**
 * The browser's print dialog for the document alone. The pages are drawn into a frame as pictures, because the browser's own PDF viewer
 * may not load in a hidden frame or under this site's object-src policy, and then printing silently does nothing.
 */
async function printPdf(file: PdfFile) {
  const frame = document.createElement('iframe'), urls: string[] = [];
  frame.title = 'Print'; frame.setAttribute('aria-hidden', 'true'); frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  (document.activeElement?.closest('dialog') ?? document.body).append(frame);
  const finish = () => { frame.remove(); urls.forEach(url => URL.revokeObjectURL(url)); };
  try {
    const target = frame.contentDocument!, images: HTMLImageElement[] = [];
    const style = target.createElement('style');
    style.textContent = '@page{margin:0}html,body{margin:0}img{display:block;width:100%;max-height:99vh;object-fit:contain;break-after:page}img:last-child{break-after:auto}';
    target.head.append(style);
    for (let number = 1; number <= file.pdf.numPages; number += 1) {
      const page = await file.pdf.getPage(number), full = page.getViewport({ scale: 2 }), viewport = page.getViewport({ scale: 2 * canvasScale(full.width, full.height) }), canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport, intent: 'print' }).promise;
      const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, 'image/jpeg', 0.92));
      canvas.width = 0; canvas.height = 0;
      if (!blob) throw new Error('page');
      const url = URL.createObjectURL(blob), image = target.createElement('img');
      urls.push(url); image.src = url; image.alt = ''; target.body.append(image); images.push(image);
    }
    await Promise.all(images.map(image => image.decode()));
    const view = frame.contentWindow!;
    // Browsers that return from print() at once still need the frame while their dialog is open.
    const timer = setTimeout(finish, 120_000);
    view.addEventListener('afterprint', () => { clearTimeout(timer); finish(); }, { once: true });
    view.focus(); view.print();
  } catch { finish(); downloadBlob(file.blob, file.filename); }
}
/** Print, or the download when the browser can't. Long documents take a moment to prepare. */
export function PrintButton({ file, variant = 'ghost', size = 'sm', className }: { file: PdfFile | null; variant?: 'ghost' | 'outline'; size?: 'sm' | 'default'; className?: string }) {
  const [busy, setBusy] = useState(false);
  return <Button type="button" variant={variant} size={size} className={className} disabled={!file || busy} onClick={() => { if (!file) return; setBusy(true); void printPdf(file).finally(() => setBusy(false)); }}><Printer aria-hidden="true" className="size-4" />{busy ? 'Preparing…' : 'Print'}</Button>;
}
