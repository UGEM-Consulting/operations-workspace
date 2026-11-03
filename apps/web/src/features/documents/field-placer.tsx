'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Eye, EyeOff, Trash2 } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/client-api';
import { cn } from '@/lib/utils';
import { DocumentModal } from './document-modal';
import { FieldMark, fieldLabels, fieldText, type DocumentField, type FieldKind, type FieldSigner } from './fields';
import { PdfPages, usePdf } from './pdf';

const SIZES: Record<FieldKind, { width: number; height: number }> = { SIGNATURE: { width: 0.3, height: 0.02 }, NAME: { width: 0.3, height: 0.018 }, DATE: { width: 0.24, height: 0.018 }, DAY: { width: 0.03, height: 0.018 }, MONTH: { width: 0.09, height: 0.018 }, YEAR: { width: 0.03, height: 0.018 }, TITLE: { width: 0.3, height: 0.018 } };
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
const SIGNER_KINDS: FieldKind[] = ['SIGNATURE', 'NAME', 'DATE', 'DAY', 'MONTH', 'YEAR'];
const COMPANY_KINDS: FieldKind[] = ['SIGNATURE', 'NAME', 'TITLE', 'DATE'];
const companyLabels: Partial<Record<FieldKind, string>> = { NAME: 'Name', DATE: 'Date' };
const sample = { name: 'Riley Santos', title: 'Dispatch manager', at: new Date() };

function Palette({ heading, kinds, signer, onStart, onChoose }: { heading: string; kinds: FieldKind[]; signer: FieldSigner; onStart: (event: React.PointerEvent, kind: FieldKind, signer: FieldSigner) => void; onChoose: (kind: FieldKind, signer: FieldSigner) => void }) {
  return <div className="space-y-2"><p className="text-[13px] font-semibold">{heading}</p>
    {kinds.map(kind => <button key={kind} type="button" onPointerDown={event => onStart(event, kind, signer)} onClick={() => onChoose(kind, signer)}
      className={cn('block min-h-8 w-full cursor-grab touch-none rounded-sm border border-dashed px-2.5 py-1 text-left text-[13px] font-medium', signer === 'COMPANY' ? 'border-indigo-500 bg-indigo-50 text-indigo-800' : 'border-orange-700 bg-orange-50 text-orange-800')}>{signer === 'COMPANY' ? companyLabels[kind] ?? fieldLabels[kind] : fieldLabels[kind]}</button>)}</div>;
}
/**
 * Marks where a version's fields go, once, when it is published. Drag a field from the side onto a page, or choose it to add it to the
 * page in view; drag to move, drag the corner or hold Alt with the arrow keys to resize, arrow keys nudge the selected one, Delete removes it. The last version's
 * layout is offered first. Publishing with none signs as before, with a certificate page only.
 */
export function FieldPlacer({ file: pdfFile, title, signerLabel, signature = true, countersign = false, initial, onPublish, onBack }: { file: File; title: string; signerLabel: string; signature?: boolean; countersign?: boolean; initial: DocumentField[];
  onPublish: (fields: DocumentField[]) => Promise<void>; onBack: () => void }) {
  const source = useMemo(() => ({ file: pdfFile }), [pdfFile]), { file, failure, reload } = usePdf(source);
  const pageCount = file?.sizes.length ?? 1;
  const [fields, setFields] = useState<DocumentField[]>(initial), [selected, setSelected] = useState(-1), [page, setPage] = useState(1), [zoom, setZoom] = useState(1), [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState<{ kind: FieldKind; signer: FieldSigner; x: number; y: number } | null>(null);
  const inRange = fields.filter(field => field.page <= pageCount);
  const moved = useRef(false);
  // A new field takes focus, so the arrow keys move it straight away.
  const focusNew = useRef(false), fieldsBox = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusNew.current && selected >= 0) { focusNew.current = false; fieldsBox.current?.querySelector<HTMLElement>(`[data-field="${selected}"]`)?.focus(); } }, [selected, fields]);
  function add(kind: FieldKind, signer: FieldSigner, target = page, x = 0.33, y = 0.45) {
    focusNew.current = true;
    const size = SIZES[kind];
    setFields(current => { setSelected(current.length); return [...current, { page: target, kind, signer, ...size, x: clamp(x, 0, 1 - size.width), y: clamp(y, 0, 1 - size.height) }]; });
  }
  const update = (index: number, change: Partial<DocumentField>) => setFields(current => current.map((field, position) => position === index ? { ...field, ...change } : field));
  const remove = (index: number) => { setFields(current => current.filter((_, position) => position !== index)); setSelected(-1); };
  function startPalette(event: React.PointerEvent, kind: FieldKind, signer: FieldSigner) {
    moved.current = false;
    const startX = event.clientX, startY = event.clientY;
    const move = (next: PointerEvent) => { if (Math.abs(next.clientX - startX) + Math.abs(next.clientY - startY) > 6) { moved.current = true; setDragging({ kind, signer, x: next.clientX, y: next.clientY }); } };
    const up = (next: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setDragging(null);
      if (!moved.current) return;
      const over = document.elementsFromPoint(next.clientX, next.clientY).find(element => element instanceof HTMLElement && element.dataset.pdfPage) as HTMLElement | undefined;
      if (over) { const box = over.getBoundingClientRect(), size = SIZES[kind]; add(kind, signer, Number(over.dataset.pdfPage), (next.clientX - box.left) / box.width - size.width / 2, (next.clientY - box.top) / box.height - size.height / 2); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  function choose(kind: FieldKind, signer: FieldSigner) { if (!moved.current) add(kind, signer); moved.current = false; }
  function startMove(event: React.PointerEvent, index: number, mode: 'move' | 'size', width: number, height: number) {
    event.preventDefault(); event.stopPropagation(); setSelected(index);
    const origin = fields[index], startX = event.clientX, startY = event.clientY;
    const move = (next: PointerEvent) => {
      const dx = (next.clientX - startX) / width, dy = (next.clientY - startY) / height;
      if (mode === 'move') update(index, { x: clamp(origin.x + dx, 0, 1 - origin.width), y: clamp(origin.y + dy, 0, 1 - origin.height) });
      else update(index, { width: clamp(origin.width + dx, 0.02, 1 - origin.x), height: clamp(origin.height + dy, 0.012, 1 - origin.y) });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  function nudge(event: React.KeyboardEvent, index: number) {
    const field = fields[index], step = event.shiftKey ? 0.01 : 0.002;
    const moves: Record<string, Partial<DocumentField>> = event.altKey ? { ArrowLeft: { width: clamp(field.width - step, 0.02, 1 - field.x) }, ArrowRight: { width: clamp(field.width + step, 0.02, 1 - field.x) }, ArrowUp: { height: clamp(field.height - step, 0.012, 1 - field.y) }, ArrowDown: { height: clamp(field.height + step, 0.012, 1 - field.y) } } : { ArrowLeft: { x: clamp(field.x - step, 0, 1 - field.width) }, ArrowRight: { x: clamp(field.x + step, 0, 1 - field.width) }, ArrowUp: { y: clamp(field.y - step, 0, 1 - field.height) }, ArrowDown: { y: clamp(field.y + step, 0, 1 - field.height) } };
    if (moves[event.key]) { event.preventDefault(); update(index, moves[event.key]); }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(index); }
  }
  const onProgress = useCallback((current: number) => setPage(current), []);
  const overlay = (number: number, width: number, height: number) => fields.map((field, index) => {
    if (field.page !== number) return null;
    const label = `${field.signer === 'COMPANY' ? 'UGEM: ' : ''}${field.signer === 'COMPANY' ? companyLabels[field.kind] ?? fieldLabels[field.kind] : fieldLabels[field.kind]}`;
    if (preview) return field.kind === 'SIGNATURE' ? <FieldMark key={index} field={field} pageWidth={width} pageHeight={height} text={sample.name} /> : <FieldMark key={index} field={field} pageWidth={width} pageHeight={height} text={fieldText(field.kind, sample)} />;
    return <div key={index} data-field={index} role="button" tabIndex={0} aria-label={`${label}, page ${number}. Arrow keys move it, Alt with the arrow keys resizes it, Delete removes it.`} aria-pressed={selected === index}
      onPointerDown={event => startMove(event, index, 'move', width, height)} onFocus={() => setSelected(index)} onKeyDown={event => nudge(event, index)}
      className={cn('absolute cursor-move touch-none select-none outline-none', selected === index && 'ring-2 ring-primary ring-offset-1')} style={{ left: field.x * width, top: field.y * height, width: field.width * width, height: field.height * height }}>
      <FieldMark field={{ ...field, x: 0, y: 0, width: 1, height: 1 }} pageWidth={field.width * width} pageHeight={field.height * height} label={label} />
      {selected === index && <span aria-hidden="true" onPointerDown={event => startMove(event, index, 'size', width, height)} className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize touch-none rounded-sm border border-primary bg-card after:absolute after:-inset-2 after:content-['']" />}
    </div>;
  });
  async function publish() {
    setBusy(true); setError('');
    try { await onPublish(inRange); }
    catch (failed) { setError(errorMessage(failed, 'Unable to publish. Please try again.')); }
    finally { setBusy(false); }
  }
  const signerKinds = signature ? SIGNER_KINDS : SIGNER_KINDS.filter(kind => kind !== 'SIGNATURE');
  const counts = (number: number) => inRange.filter(field => field.page === number).length;
  const panel = <>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 max-lg:max-h-[38dvh] lg:p-5">
      <div><h3 className="text-[17px] font-semibold leading-6">Place the fields</h3><p className="mt-1 text-[13px] leading-5 text-muted-foreground">Drag each one onto its line, or choose it to add it to the page in view. {signerLabel} only types a name and signs once; every place fills in from that.</p></div>
      <Palette heading={`${signerLabel} fills`} kinds={signerKinds} signer="SIGNER" onStart={startPalette} onChoose={choose} />
      {countersign && <Palette heading="UGEM fills at approval" kinds={COMPANY_KINDS} signer="COMPANY" onStart={startPalette} onChoose={choose} />}
      {selected >= 0 && fields[selected] && <Button type="button" size="sm" variant="outline" onClick={() => remove(selected)}><Trash2 aria-hidden="true" className="size-4" />Remove selected field</Button>}
      {file && <ol className="space-y-1 text-[13px]">{file.sizes.map((_, index) => <li key={index} className={cn('flex justify-between rounded-sm px-2 py-1', page === index + 1 ? 'bg-brand-subtle font-medium' : 'text-muted-foreground')}>Page {index + 1}<span>{counts(index + 1) ? `${counts(index + 1)} ${counts(index + 1) === 1 ? 'field' : 'fields'}` : ''}</span></li>)}</ol>}
    </div>
    <div className="shrink-0 space-y-3 border-t p-4 lg:px-5">
      {inRange.length ? <p className="text-[13px] leading-5 text-muted-foreground">{inRange.filter(field => field.signer === 'SIGNER').length} places for {signerLabel.toLowerCase()}{countersign ? `, ${inRange.filter(field => field.signer === 'COMPANY').length} for UGEM` : ''}.</p>
        : <Alert tone="warning"><p>With no fields, signed copies have only the certificate page and the form’s lines stay blank.</p></Alert>}
      <Notice message={error} error />
      <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" aria-pressed={preview} onClick={() => setPreview(value => !value)}>{preview ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}{preview ? 'Edit' : 'Preview'}</Button>
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>Back</Button></div>
      <Button type="button" size="lg" className="w-full" disabled={busy || !file} onClick={() => void publish()}><Check aria-hidden="true" className="size-4" />{busy ? 'Publishing…' : 'Publish version'}</Button>
    </div>
  </>;
  return <DocumentModal title={`Publish ${title}: place the signing fields`} meta={`${pdfFile.name}${file ? ` · ${file.sizes.length} ${file.sizes.length === 1 ? 'page' : 'pages'}` : ''}`} file={file} failure={failure} reload={reload} zoom={zoom} onZoom={setZoom} onClose={onBack} busy={busy} closeLabel="Back to publishing"
      floating={dragging && <div aria-hidden="true" className="pointer-events-none fixed z-50 rounded-sm border border-dashed border-primary bg-card px-2 py-1 text-[13px] font-medium shadow-md" style={{ left: dragging.x + 8, top: dragging.y + 8 }}>{fieldLabels[dragging.kind]}</div>}
      panel={panel} pages={file && <div ref={fieldsBox} className="flex min-h-0 flex-1 flex-col"><PdfPages file={file} zoom={zoom} overlay={overlay} onProgress={onProgress} text={false} className="flex-1" /></div>} />;
}
