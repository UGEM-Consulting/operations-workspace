'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Eye, Upload } from 'lucide-react';
import { Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { ViewDocumentButton, type ViewableDocument } from '@/features/documents/document-modal';
import { imageForUpload, PhotoError } from '@/features/onboarding/photo';
import { errorMessage, mutate } from '@/lib/client-api';
import { fileToBase64, MAX_PDF_BYTES } from '@/lib/files';
import { middayIso } from '@/lib/navigation';
import type { ExistingRecord, MemberProfile, PaperCopy } from './types';

// The same limits as other photographed documents: four pages, each small enough that all fit one upload.
const MAX_PAGES = 4, PAGE_BYTES = 760_000, PAGE_SIDE = 1800;
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** The scans of one paper copy for the viewer: the current one first, then the ones it replaced (PaperScanViewerScreen). */
function scanDocuments(member: MemberProfile, paper: PaperCopy): ViewableDocument[] {
 const name = `${member.firstName} ${member.lastName}`, earlier = paper.earlierScans ?? [];
 const signed = { label: 'Signed on paper', value: <LocalTime iso={middayIso(paper.signedOn)} format="date" /> };
 const current = paper.scan ? [{ url: `/api/backend/dispatch/members/${member.id}/paper-scans/${paper.scan.id}/file`, title: `${paper.kind} (paper) · ${name}`, meta: 'Scan of the paper copy',
  fallbackName: `${paper.kind.toLowerCase()}-paper-scan.pdf`,
  record: [signed, { label: 'Scan added', value: <>{paper.scan.uploadedBy}, <LocalTime iso={paper.scan.createdAt} format="date" /></> }, { label: 'Earlier scans', value: earlier.length ? `${earlier.length}, replaced` : 'None' }] }] : [];
 return [...current, ...earlier.map(scan => ({ url: `/api/backend/dispatch/members/${member.id}/paper-scans/${scan.id}/file`, title: `${paper.kind} (paper, replaced) · ${name}`,
  meta: 'Earlier scan, replaced', fallbackName: `${paper.kind.toLowerCase()}-paper-scan.pdf`,
  record: [signed, { label: 'Scan added', value: <>{scan.uploadedBy}, <LocalTime iso={scan.createdAt} format="date" /></> }, { label: 'Replaced', value: <LocalTime iso={scan.replacedAt} format="date" /> }] }))];
}

/**
 * History entries for someone added by hand (PaperScanProfileScreen): each paper scan, the first of a kind added and later
 * ones replacing it, and when the record was added. Each has `at` for sorting with the other history entries.
 */
export function paperScanItems(existing: ExistingRecord) {
 const pages = (count: number) => `${count} ${count === 1 ? 'page' : 'pages'}.`;
 const scans = existing.paper.flatMap(paper => [...(paper.earlierScans ?? []), ...(paper.scan ? [paper.scan] : [])]
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  .map((scan, index) => ({ id: scan.id, at: scan.createdAt, title: `Paper ${paper.kind} scan ${index ? 'replaced' : 'added'}`, body: pages(scan.pageCount),
   meta: <>{scan.uploadedBy} · <LocalTime iso={scan.createdAt} format="date" /></> })));
 return [...scans, { id: 'added', at: existing.createdAt, title: existing.sourceName ? `Added from ${existing.sourceName}` : 'Added by hand',
  meta: <>{existing.addedBy} · <LocalTime iso={existing.createdAt} format="date" /></> }];
}

/** The Paperwork card's action for a paper copy: Add scan, or View with Replace beside it (PaperScanAddScreen, PaperScanProfileScreen). */
export function PaperScanActions({ member, paper }: { member: MemberProfile; paper: PaperCopy }) {
 const [open, setOpen] = useState(false);
 const left = member.status === 'LEFT';
 if (!paper.scan) return left ? null : <><Button size="sm" variant="outline" onClick={() => setOpen(true)}><Upload aria-hidden="true" className="size-4" />Add scan</Button>
  {open && <PaperScanDialog member={member} paper={paper} onClose={() => setOpen(false)} />}</>;
 return <span className="inline-flex flex-wrap justify-end gap-1">
  <ViewDocumentButton documents={scanDocuments(member, paper)}><Eye aria-hidden="true" className="size-4" />View</ViewDocumentButton>
  {!left && <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Replace</Button>}
  {open && <PaperScanDialog member={member} paper={paper} onClose={() => setOpen(false)} />}</span>;
}

/**
 * Adding or replacing the scan of an NDA or SOP signed on paper (PaperScanUploadScreen, PaperScanReplaceScreen): one PDF, or
 * photos of up to four pages that become one PDF in the order chosen. The date can be corrected; the statement is required.
 * Only the NDA or SOP: never ID cards, SSNs or other personal documents.
 */
export function PaperScanDialog({ member, paper, onClose }: { member: MemberProfile; paper: PaperCopy; onClose: () => void }) {
 const router = useRouter(), toast = useToast();
 const [pending, setPending] = useState(false);
 const [error, setError] = useState(''), [fileError, setFileError] = useState('');
 const name = `${member.firstName} ${member.lastName}`, replacing = !!paper.scan;
 // Chosen photos in page order, to check before saving (PaperScanUploadScreen). Released when the choice changes or the dialog closes.
 const [previews, setPreviews] = useState<string[]>([]);
 useEffect(() => () => previews.forEach(url => URL.revokeObjectURL(url)), [previews]);
 function choose(event: React.ChangeEvent<HTMLInputElement>) {
  setFileError('');
  const files = Array.from(event.target.files ?? []);
  setPreviews(files.length <= MAX_PAGES && files.every(file => file.type.startsWith('image/')) ? files.map(file => URL.createObjectURL(file)) : []);
 }
 async function submit(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if (pending) return;
  const form = new FormData(event.currentTarget);
  setPending(true); setError(''); setFileError('');
  try {
   const files = (form.getAll('file') as File[]).filter(file => file.size > 0);
   const pdfs = files.filter(file => file.type === 'application/pdf');
   if (!files.length) { setFileError('Choose a PDF, or photos of each page.'); return; }
   if (pdfs.length && files.length > 1) { setFileError('Choose one PDF, or photos only.'); return; }
   if (pdfs.length && pdfs[0].size > MAX_PDF_BYTES) { setFileError('The PDF is larger than 3 MB.'); return; }
   if (files.length > MAX_PAGES) { setFileError(`Choose at most ${MAX_PAGES} photos, one per page, or upload a PDF.`); return; }
   // One photo at a time: decoding several full-size photos at once can exhaust a phone's memory.
   const pages: string[] = [];
   if (!pdfs.length) for (const file of files) pages.push(await imageForUpload(file, { maxSide: PAGE_SIDE, maxBytes: PAGE_BYTES }));
   const signedOn = String(form.get('signedOn') ?? '');
   await mutate(`dispatch/members/${member.id}/paper-scans`, 'POST', { version: member.version, kind: paper.kind, ...(pdfs.length ? { file: await fileToBase64(pdfs[0]) } : { pages }),
    ...(signedOn && signedOn !== paper.signedOn ? { signedOn } : {}), confirmed: form.get('confirmed') === 'on' });
   toast({ title: replacing ? `${paper.kind} scan replaced` : `${paper.kind} scan added`, description: replacing ? 'The earlier scan is kept, listed as replaced.' : undefined });
   onClose(); router.refresh();
  } catch (error) {
   if (error instanceof PhotoError) setFileError(error.message);
   else setError(errorMessage(error, 'Unable to save. Your entries have been kept.'));
  } finally { setPending(false); }
 }
 return <Dialog open onClose={onClose} busy={pending} title={replacing ? `Replace the paper ${paper.kind} scan` : `Add the paper ${paper.kind} scan`}
  description={replacing ? 'Use this when a page was missing or unreadable. The earlier scan is kept in the record and listed as replaced.'
   : `${name} · signed on paper ${new Date(middayIso(paper.signedOn)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}. The paper copy stays on file with the company.`}
  actions={<Button type="submit" form="paper-scan" disabled={pending}>{pending ? 'Saving…' : <><Upload aria-hidden="true" className="size-4" />Save scan</>}</Button>}>
  <form id="paper-scan" onSubmit={submit} className="space-y-4">
   <Field id="paper-scan-file" label="Scan or photos" hint={`One PDF (3 MB maximum), or photos of up to ${MAX_PAGES} pages, chosen in page order. Photograph each page flat and in good light.`} error={fileError}>
    <input id="paper-scan-file" name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/heic" multiple required
     aria-invalid={fileError ? true : undefined} aria-describedby={fileError ? 'paper-scan-file-hint paper-scan-file-error' : 'paper-scan-file-hint'} onChange={choose}
     className="block w-full text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-sm file:border file:border-input file:bg-card file:px-3 file:text-sm file:font-medium file:shadow-xs hover:file:bg-accent" /></Field>
   {previews.length > 0 && <div><p className="mb-2 text-[13px] leading-5 text-muted-foreground">Pages in order</p>
    <ol className="grid grid-cols-4 gap-2">{previews.map((url, index) => <li key={url} className="relative aspect-[3/4] overflow-hidden rounded-sm border border-border bg-muted">
     {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the chosen photo, never uploaded as is */}
     <img src={url} alt={`Page ${index + 1}`} className="size-full object-cover" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} />
     <span className="absolute bottom-1 left-1 rounded-xs bg-card/90 px-1 text-xs">Page {index + 1}</span></li>)}</ol></div>}
   <Input label="Signed on" name="signedOn" type="date" required defaultValue={paper.signedOn} max={easternToday()} width="sm" hint="The date written on the paper. Change it only if it was recorded wrong." />
   <Checkbox name="confirmed" required label={`This is ${name}’s signed ${paper.kind}, every page.`} />
   <p className="text-[13px] leading-5 text-muted-foreground">Only the NDA or SOP. Never ID cards, SSNs or other personal documents.</p>
   <Notice message={error} error />
   <PendingHint pending={pending} />
  </form>
 </Dialog>;
}
