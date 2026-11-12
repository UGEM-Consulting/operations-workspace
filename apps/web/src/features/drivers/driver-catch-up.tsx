'use client';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { ApiError, errorMessage, mutate } from '@/lib/client-api';
import { ConsentSigning, type ConsentItem } from './consent-signing';
import { DocumentScanner } from './document-scanner';
import { DriverTelegram } from './driver-telegram';

type Kind = 'LICENSE' | 'MEDICAL_CARD' | 'WORK_AUTHORIZATION';
export interface DriverCatchUpView { purpose: 'CATCH_UP'; firstName: string; email: string; expiresAt: string; sentAt: string | null; documentsEnabled: boolean;
  documents: { kind: Kind; scan: { id: string; subtype: string | null; pageCount: number; createdAt: string } | null }[];
  consents: { required: boolean; consent: string; items: ConsentItem[] }; missing: string[] }
const hints: Record<Kind, string> = { LICENSE: 'Front and back of your current license.', MEDICAL_CARD: 'Your newest DOT medical examiner’s certificate.', WORK_AUTHORIZATION: 'Any document you choose, such as a green card.' };
const noDraft = () => {};

/**
 * The page a catch-up link opens after the emailed code (DriverCatchUpPhoneScreen): it says plainly that they already drive
 * for UGEM, then asks for photos of their current documents and the current consent forms. No SSN and no application.
 */
export function DriverCatchUp({ view: initial, focusHeading, onEnded }: { view: DriverCatchUpView; focusHeading: boolean; onEnded: (end: string | ApiError) => void }) {
  const [view, setView] = useState(initial), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focusHeading || view.sentAt) heading.current?.focus(); }, [focusHeading, view.sentAt]);
  async function send() {
    if (busy) return;
    setBusy(true); setMessage('');
    try { setView(await mutate<DriverCatchUpView>('driver/catch-up/send', 'POST', {})); }
    catch (error) { if (error instanceof ApiError && error.kind === 'applicant-session') { onEnded(error); return; } setMessage(errorMessage(error, 'It wasn’t sent. Try again.')); }
    finally { setBusy(false); }
  }
  if (view.sentAt) return <Card className="space-y-4 p-6 sm:p-8">
    <CheckCircle2 aria-hidden="true" className="size-8 text-success" />
    <h1 ref={heading} tabIndex={-1} className="text-2xl font-normal outline-none">Sent to Safety</h1>
    <p className="text-sm text-muted-foreground">Thank you. Safety received your photos and forms on <LocalTime iso={view.sentAt} format="date" /> and checks the photos before they count. Until then your file stays as it is. You can close this page.</p>
    <DriverTelegram />
  </Card>;
  return <Card className="space-y-6 p-6 sm:p-8">
    <div className="space-y-2">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-normal outline-none">Bring your file up to date</h1>
      <p className="text-sm text-muted-foreground">UGEM Safety asked for photos of your current documents. The link works until <LocalTime iso={view.expiresAt} format="date" />.</p>
    </div>
    <Alert tone="info" title="You already drive for UGEM"><p>This only updates your file. It isn’t a new application, and nothing about your work changes.</p></Alert>
    {view.documentsEnabled && <section className="space-y-3" aria-labelledby="catch-up-documents">
      <h2 id="catch-up-documents" className="text-lg font-medium">Your documents</h2>
      {view.documents.map(item => <DocumentScanner key={item.kind} kind={item.kind} required onEnded={onEnded} onDraft={noDraft}
        catchUp={{ current: item.scan, hint: hints[item.kind], onSaved: next => setView(next as DriverCatchUpView) }} />)}
    </section>}
    {view.consents.required && view.consents.items.length > 0 && <section className="space-y-3" aria-labelledby="catch-up-forms">
      <h2 id="catch-up-forms" className="text-lg font-medium">Forms to sign</h2>
      <p className="text-sm text-muted-foreground">Safety needs these on file before the next driving record check.</p>
      <ConsentSigning view={view} onSaved={setView} onEnded={onEnded} editable />
    </section>}
    {message && <p className="text-sm text-danger" role="alert">{message}</p>}
    <Button size="lg" className="w-full" disabled={busy || view.missing.length > 0} onClick={() => void send()}>{busy ? 'Sending…' : 'Send to Safety'}</Button>
    <PendingHint pending={busy} />
    <p className="text-[13px] text-muted-foreground">Send when every document and form is done. Safety checks the photos before they count; until then your file stays as it is.</p>
  </Card>;
}
