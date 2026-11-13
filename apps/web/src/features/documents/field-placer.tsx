'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Eye, EyeOff, Trash2 } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/field';
import { errorMessage } from '@/lib/client-api';
import { cn } from '@/lib/utils';
import { DocumentModal } from './document-modal';
import { FieldMark, fieldLabels, fieldText, type DocumentField, type FieldKind, type FieldSigner } from './fields';
import { findLines, nearestLine, onLine, overlaps, printedShare, type FormLine } from './lines';
import { PdfPages, usePdf, type PdfFile } from './pdf';

const SIZES: Record<FieldKind, { width: number; height: number }> = { ADDRESS: { width: 0.45, height: 0.018 }, SIGNATURE: { width: 0.3, height: 0.02 }, NAME: { width: 0.3, height: 0.018 }, AMERICAN_NAME: { width: 0.3, height: 0.018 }, DATE: { width: 0.24, height: 0.018 }, DAY: { width: 0.03, height: 0.018 }, MONTH: { width: 0.09, height: 0.018 }, YEAR: { width: 0.03, height: 0.018 }, TITLE: { width: 0.3, height: 0.018 } };
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
const SIGNER_KINDS: FieldKind[] = ['SIGNATURE', 'NAME', 'DATE', 'DAY', 'MONTH', 'YEAR'];
const COMPANY_KINDS: FieldKind[] = ['SIGNATURE', 'NAME', 'TITLE', 'DATE'];
const companyLabels: Partial<Record<FieldKind, string>> = { NAME: 'Name', DATE: 'Date' };
const sample = { name: 'Riley Santos', american: 'Riley Santos', title: 'Dispatch manager', address: '100 Example Street, Austin, TX 73301', at: new Date() };
/** Pages looked at for lines; later pages of a long document place fields as before. */
const SCANNED_PAGES = 10;

/** A page drawn once in the browser for snapping (section 16): its empty lines, and its pixels to tell what a field would cover. */
interface PageScan { lines: FormLine[]; pixels: Uint8ClampedArray; width: number; height: number }
/** Finds each page's lines once the PDF opens. Nothing leaves the browser and no text is read, so scans work too. */
function useFormLines(file: PdfFile | null) {
  const [scans, setScans] = useState<Record<number, PageScan>>({});
  useEffect(() => {
    if (!file) return;
    let current = true;
    void (async () => {
      for (let number = 1; number <= Math.min(file.sizes.length, SCANNED_PAGES) && current; number += 1) {
        try {
          const page = await file.pdf.getPage(number), base = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: Math.min(2, 800 / base.width) });
          const canvas = document.createElement('canvas'); canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) continue;
          context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: context, viewport }).promise;
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height), scan = { lines: findLines(data, canvas.width, canvas.height), pixels: data, width: canvas.width, height: canvas.height };
          canvas.width = 0; canvas.height = 0;
          if (current) setScans(found => ({ ...found, [number]: scan }));
        } catch { /* A page that can't be drawn snaps nothing; its fields stay where they're dropped. */ }
      }
    })();
    return () => { current = false; };
  }, [file]);
  return scans;
}

function Palette({ heading, kinds, signer, placing, onStart, onChoose }: { heading: string; kinds: FieldKind[]; signer: FieldSigner; placing: { kind: FieldKind; signer: FieldSigner } | null; onStart: (event: React.PointerEvent, kind: FieldKind, signer: FieldSigner) => void; onChoose: (kind: FieldKind, signer: FieldSigner) => void }) {
  return <div className="space-y-2"><p className="text-[13px] font-semibold">{heading}</p>
    {kinds.map(kind => { const chosen = placing?.kind === kind && placing.signer === signer;
      return <button key={kind} type="button" onPointerDown={event => onStart(event, kind, signer)} onClick={() => onChoose(kind, signer)} aria-pressed={chosen}
        className={cn('block min-h-8 w-full cursor-grab touch-none rounded-sm border border-dashed px-2.5 py-1 text-left text-[13px] font-medium', signer === 'COMPANY' ? 'border-indigo-500 bg-indigo-50 text-indigo-800' : 'border-orange-700 bg-orange-50 text-orange-800', chosen && 'ring-2 ring-primary ring-offset-1')}>{signer === 'COMPANY' ? companyLabels[kind] ?? fieldLabels[kind] : fieldLabels[kind]}</button>; })}</div>;
}
/**
 * Marks where a version's fields go, once, when it is published. Drag a field from the side onto its line, or choose it and then
 * click its line: with Snap to lines on (section 16), a field dropped near an empty line lands on it, as wide as it, and a signature
 * never reaches the line above. Drag to move (a move near a line snaps too), drag the corner or hold Alt with the arrow keys to
 * resize, arrow keys nudge the selected one (neither snaps), Delete removes it. Fields that cover printing or each other are
 * marked; that never stops publishing. The last version's layout is offered first. Publishing with none signs as before, with a
 * certificate page only.
 */
export function FieldPlacer({ file: pdfFile, title, signerLabel, signature = true, countersign = false, americanName = false, letter = false, address = false, company = 'UGEM', initial, onPublish, onBack }: { file: File; title: string; signerLabel: string; signature?: boolean; countersign?: boolean; /** New hires have one; drivers don't. */ americanName?: boolean;
  /** The driver's address, filled in when they sign (the Driver and Contractor Acknowledgement). */ address?: boolean; /** Who countersigns: UGEM at approval, or a truck owner's signer. */ company?: string;
  /** A notice letter: nobody signs it; the driver's name, address and the date fill in when Safety downloads it. */ letter?: boolean; initial: DocumentField[];
  onPublish: (fields: DocumentField[]) => Promise<void>; onBack: () => void }) {
  const source = useMemo(() => ({ file: pdfFile }), [pdfFile]), { file, failure, reload } = usePdf(source);
  const pageCount = file?.sizes.length ?? 1;
  const [fields, setFields] = useState<DocumentField[]>(initial), [selected, setSelected] = useState(-1), [page, setPage] = useState(1), [zoom, setZoom] = useState(1), [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState<{ kind: FieldKind; signer: FieldSigner; x: number; y: number; line: FormLine | null } | null>(null);
  const [snap, setSnap] = useState(true), [placing, setPlacing] = useState<{ kind: FieldKind; signer: FieldSigner } | null>(null);
  const scans = useFormLines(file);
  const linesOf = (number: number) => snap ? scans[number]?.lines ?? [] : [];
  const inRange = fields.filter(field => field.page <= pageCount);
  const moved = useRef(false);
  // A new field takes focus, so the arrow keys move it straight away.
  const focusNew = useRef(false), fieldsBox = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusNew.current && selected >= 0) { focusNew.current = false; fieldsBox.current?.querySelector<HTMLElement>(`[data-field="${selected}"]`)?.focus(); } }, [selected, fields]);
  useEffect(() => {
    if (!placing) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPlacing(null); } };
    window.addEventListener('keydown', cancel, true); return () => window.removeEventListener('keydown', cancel, true);
  }, [placing]);
  /** Where a field dropped at a point lands: on the nearest empty line when one is close (any line, when it was chosen and then clicked). */
  function landing(kind: FieldKind, target: number, x: number, y: number, anyLine: boolean) {
    const size = SIZES[kind], lines = linesOf(target), line = nearestLine(lines, x, y, anyLine ? null : 0.03);
    return line ? onLine(line, kind, size.height, lines) : { ...size, x: clamp(x - size.width / 2, 0, 1 - size.width), y: clamp(y - size.height / 2, 0, 1 - size.height) };
  }
  function add(kind: FieldKind, signer: FieldSigner, target = page, x = 0.48, y = 0.46, anyLine = false) {
    focusNew.current = true;
    const box = landing(kind, target, x, y, anyLine);
    setFields(current => { setSelected(current.length); return [...current, { page: target, kind, signer, ...box }]; });
  }
  const update = (index: number, change: Partial<DocumentField>) => setFields(current => current.map((field, position) => position === index ? { ...field, ...change } : field));
  const remove = (index: number) => { setFields(current => current.filter((_, position) => position !== index)); setSelected(-1); };
  const pageAt = (clientX: number, clientY: number) => {
    const over = document.elementsFromPoint(clientX, clientY).find(element => element instanceof HTMLElement && element.dataset.pdfPage) as HTMLElement | undefined;
    if (!over) return null;
    const box = over.getBoundingClientRect();
    return { page: Number(over.dataset.pdfPage), x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height };
  };
  function startPalette(event: React.PointerEvent, kind: FieldKind, signer: FieldSigner) {
    moved.current = false;
    const startX = event.clientX, startY = event.clientY;
    const move = (next: PointerEvent) => {
      if (Math.abs(next.clientX - startX) + Math.abs(next.clientY - startY) <= 6) return;
      moved.current = true; setPlacing(null);
      // The line it would land on lights up while dragging.
      const at = pageAt(next.clientX, next.clientY);
      setDragging({ kind, signer, x: next.clientX, y: next.clientY, line: at ? nearestLine(linesOf(at.page), at.x, at.y) : null });
    };
    const up = (next: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setDragging(null);
      if (!moved.current) return;
      const at = pageAt(next.clientX, next.clientY);
      if (at) add(kind, signer, at.page, at.x, at.y);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  // Choosing a field waits for a click on its line; with snapping off or no lines found, it goes on the page in view as before.
  function choose(kind: FieldKind, signer: FieldSigner) {
    if (moved.current) { moved.current = false; return; }
    if (snap && Object.values(scans).some(scan => scan.lines.length)) setPlacing(current => current?.kind === kind && current.signer === signer ? null : { kind, signer });
    else add(kind, signer);
  }
  function place(event: React.MouseEvent, number: number) {
    if (!placing) return;
    const box = event.currentTarget.getBoundingClientRect();
    add(placing.kind, placing.signer, number, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height, true);
    setPlacing(null);
  }
  function startMove(event: React.PointerEvent, index: number, mode: 'move' | 'size', width: number, height: number) {
    event.preventDefault(); event.stopPropagation(); setSelected(index);
    const origin = fields[index], startX = event.clientX, startY = event.clientY;
    let last: DocumentField | null = null;
    const move = (next: PointerEvent) => {
      const dx = (next.clientX - startX) / width, dy = (next.clientY - startY) / height;
      last = mode === 'move' ? { ...origin, x: clamp(origin.x + dx, 0, 1 - origin.width), y: clamp(origin.y + dy, 0, 1 - origin.height) }
        : { ...origin, width: clamp(origin.width + dx, 0.02, 1 - origin.x), height: clamp(origin.height + dy, 0.012, 1 - origin.y) };
      update(index, last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      // A field moved near a line lands on it; resizing never snaps.
      const end = last;
      if (mode !== 'move' || !end) return;
      const lines = linesOf(origin.page), line = nearestLine(lines, end.x + end.width / 2, end.y + end.height);
      if (line) update(index, onLine(line, origin.kind, origin.kind === 'SIGNATURE' ? SIZES.SIGNATURE.height : origin.height, lines));
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  function nudge(event: React.KeyboardEvent, index: number) {
    const field = fields[index], step = event.shiftKey ? 0.01 : 0.002;
    const moves: Record<string, Partial<DocumentField>> = event.altKey ? { ArrowLeft: { width: clamp(field.width - step, 0.02, 1 - field.x) }, ArrowRight: { width: clamp(field.width + step, 0.02, 1 - field.x) }, ArrowUp: { height: clamp(field.height - step, 0.012, 1 - field.y) }, ArrowDown: { height: clamp(field.height + step, 0.012, 1 - field.y) } } : { ArrowLeft: { x: clamp(field.x - step, 0, 1 - field.width) }, ArrowRight: { x: clamp(field.x + step, 0, 1 - field.width) }, ArrowUp: { y: clamp(field.y - step, 0, 1 - field.height) }, ArrowDown: { y: clamp(field.y + step, 0, 1 - field.height) } };
    if (moves[event.key]) { event.preventDefault(); update(index, moves[event.key]); }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(index); }
  }
  // A field that covers something printed, or another field, is marked; that never stops publishing.
  const warnings = useMemo(() => fields.map((field, index) => {
    const scan = scans[field.page];
    if (scan && printedShare(scan.pixels, scan.width, scan.height, field) > 0.08) return 'covers something already printed';
    if (fields.some((other, at) => at !== index && other.page === field.page && overlaps(field, other))) return 'overlaps another field';
    return null;
  }), [fields, scans]);
  const onProgress = useCallback((current: number) => setPage(current), []);
  const overlay = (number: number, width: number, height: number) => <>
    {/* The empty lines show while a field is dragged or chosen; the one it would land on is darker. */}
    {!preview && (dragging || placing) && linesOf(number).map((line, index) => <span key={`line-${index}`} aria-hidden="true" className={cn('pointer-events-none absolute rounded-full', dragging?.line === line ? 'bg-primary' : 'bg-primary/35')}
      style={{ left: line.x * width, top: line.y * height - 2, width: line.width * width, height: 4 }} />)}
    {placing && <div aria-hidden="true" onClick={event => place(event, number)} className="absolute inset-0 z-10 cursor-crosshair" />}
    {fields.map((field, index) => {
      if (field.page !== number) return null;
      const label = `${field.signer === 'COMPANY' ? 'UGEM: ' : ''}${field.signer === 'COMPANY' ? companyLabels[field.kind] ?? fieldLabels[field.kind] : fieldLabels[field.kind]}`;
      if (preview) return field.kind === 'SIGNATURE' ? <FieldMark key={index} field={field} pageWidth={width} pageHeight={height} text={sample.name} /> : <FieldMark key={index} field={field} pageWidth={width} pageHeight={height} text={fieldText(field.kind, sample)} />;
      return <div key={index} data-field={index} role="button" tabIndex={0} aria-label={`${label}, page ${number}${warnings[index] ? `, ${warnings[index]}` : ''}. Arrow keys move it, Alt with the arrow keys resizes it, Delete removes it.`} aria-pressed={selected === index}
        onPointerDown={event => startMove(event, index, 'move', width, height)} onFocus={() => setSelected(index)} onKeyDown={event => nudge(event, index)}
        className={cn('absolute cursor-move touch-none select-none outline-none', selected === index ? 'ring-2 ring-primary ring-offset-1' : warnings[index] && 'ring-2 ring-amber-500')} style={{ left: field.x * width, top: field.y * height, width: field.width * width, height: field.height * height }}>
        <FieldMark field={{ ...field, x: 0, y: 0, width: 1, height: 1 }} pageWidth={field.width * width} pageHeight={field.height * height} label={label} grow />
        {selected === index && <span aria-hidden="true" onPointerDown={event => startMove(event, index, 'size', width, height)} className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize touch-none rounded-sm border border-primary bg-card after:absolute after:-inset-2 after:content-['']" />}
      </div>;
    })}
  </>;
  async function publish() {
    setBusy(true); setError('');
    try { await onPublish(inRange); }
    catch (failed) { setError(errorMessage(failed, 'Unable to publish. Please try again.')); }
    finally { setBusy(false); }
  }
  const signerKinds: FieldKind[] = letter ? ['NAME', 'ADDRESS', 'DATE'] : SIGNER_KINDS.filter(kind => signature || kind !== 'SIGNATURE').flatMap(kind => kind === 'NAME' && americanName ? ['NAME' as const, 'AMERICAN_NAME' as const] : kind === 'NAME' && address ? ['NAME' as const, 'ADDRESS' as const] : [kind]);
  const counts = (number: number) => inRange.filter(field => field.page === number).length;
  const scanned = scans[page], found = scanned?.lines.length ?? 0;
  const warned = warnings.flatMap((warning, index) => warning && fields[index].page <= pageCount ? [{ index, warning }] : []);
  const panel = <>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 max-lg:max-h-[38dvh] lg:p-5">
      <div><h3 className="text-[17px] font-semibold leading-6">Place the fields</h3><p className="mt-1 text-[13px] leading-5 text-muted-foreground" aria-live="polite">{placing ? `Now click the line where ${fieldLabels[placing.kind]} goes. Esc cancels.` : 'Drag each one onto its line, or choose it and then click its line.'} {letter ? 'The driver’s name, address and the date fill in when Safety downloads a driver’s letter.'
        : `${signerLabel} only ${americanName ? 'checks their name' : 'types a name'} and signs once; every place fills in from that.`}</p></div>
      <Palette heading={letter ? 'Filled in for the driver' : `${signerLabel} fills`} kinds={signerKinds} signer="SIGNER" placing={placing} onStart={startPalette} onChoose={choose} />
      {countersign && <Palette heading={company === 'UGEM' ? 'UGEM fills at approval' : `${company} fills`} kinds={COMPANY_KINDS} signer="COMPANY" placing={placing} onStart={startPalette} onChoose={choose} />}
      {selected >= 0 && fields[selected] && <Button type="button" size="sm" variant="outline" onClick={() => remove(selected)}><Trash2 aria-hidden="true" className="size-4" />Remove selected field</Button>}
      <div className="space-y-1">
        <Checkbox label="Snap to lines" checked={snap} onChange={event => { setSnap(event.target.checked); setPlacing(null); }} />
        {snap && <p className="text-[13px] leading-5 text-muted-foreground">{page > SCANNED_PAGES ? `Only the first ${SCANNED_PAGES} pages are checked for lines.` : !scanned ? 'Looking for empty lines…' : found ? `Found ${found} empty ${found === 1 ? 'line' : 'lines'} on page ${page}.` : `No empty lines found on page ${page}, so fields stay where they’re dropped.`}</p>}
      </div>
      {warned.length > 0 && <Alert tone="warning" title={warned.length === 1 ? '1 field to check' : `${warned.length} fields to check`}><ul className="space-y-1">{warned.map(item => <li key={item.index}>{fieldLabels[fields[item.index].kind]} on page {fields[item.index].page} {item.warning}.</li>)}</ul><p className="mt-1">You can still publish; move it if that isn’t meant.</p></Alert>}
      {file && <ol className="space-y-1 text-[13px]">{file.sizes.map((_, index) => <li key={index} className={cn('flex justify-between rounded-sm px-2 py-1', page === index + 1 ? 'bg-brand-subtle font-medium' : 'text-muted-foreground')}>Page {index + 1}<span>{counts(index + 1) ? `${counts(index + 1)} ${counts(index + 1) === 1 ? 'field' : 'fields'}` : ''}</span></li>)}</ol>}
    </div>
    <div className="shrink-0 space-y-3 border-t p-4 lg:px-5">
      {inRange.length ? <p className="text-[13px] leading-5 text-muted-foreground">{inRange.filter(field => field.signer === 'SIGNER').length} {inRange.filter(field => field.signer === 'SIGNER').length === 1 ? 'place' : 'places'} for {signerLabel.toLowerCase()}{countersign ? `, ${inRange.filter(field => field.signer === 'COMPANY').length} for ${company === 'UGEM' ? 'UGEM' : company.toLowerCase()}` : ''}.</p>
        : <Alert tone="warning"><p>{letter ? 'With no fields, the letter downloads without the driver’s details; Safety writes them in by hand.' : 'With no fields, signed copies have only the certificate page and the form’s lines stay blank.'}</p></Alert>}
      <Notice message={error} error />
      <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" aria-pressed={preview} onClick={() => { setPreview(value => !value); setPlacing(null); }}>{preview ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}{preview ? 'Edit' : 'Preview'}</Button>
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>Back</Button></div>
      <Button type="button" size="lg" className="w-full" disabled={busy || !file} onClick={() => void publish()}><Check aria-hidden="true" className="size-4" />{busy ? 'Publishing…' : 'Publish version'}</Button>
    </div>
  </>;
  return <DocumentModal title={`Publish ${title}: place the signing fields`} meta={`${pdfFile.name}${file ? ` · ${file.sizes.length} ${file.sizes.length === 1 ? 'page' : 'pages'}` : ''}`} file={file} failure={failure} reload={reload} zoom={zoom} onZoom={setZoom} onClose={onBack} busy={busy} closeLabel="Back to publishing"
      floating={dragging && <div aria-hidden="true" className="pointer-events-none fixed z-50 rounded-sm border border-dashed border-primary bg-card px-2 py-1 text-[13px] font-medium shadow-md" style={{ left: dragging.x + 8, top: dragging.y + 8 }}>{fieldLabels[dragging.kind]}{dragging.line ? ' · on the line' : ''}</div>}
      panel={panel} pages={file && <div ref={fieldsBox} className="flex min-h-0 flex-1 flex-col"><PdfPages file={file} zoom={zoom} overlay={overlay} onProgress={onProgress} text={false} className="flex-1" /></div>} />;
}
