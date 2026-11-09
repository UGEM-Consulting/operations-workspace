'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { LocalTime } from '@/components/ui/local-time';
import { mutate } from '@/lib/client-api';
import { DocumentScanner } from './document-scanner';
import { DriverTelegram } from './driver-telegram';

export interface DriverRenewalView { kind: 'LICENSE' | 'MEDICAL_CARD'; email: string; expiresAt: string; sentAt: string | null; documentsEnabled: boolean;
  document: { id: string; pageCount: number; createdAt: string } | null }
const words = { LICENSE: 'driver’s license', MEDICAL_CARD: 'medical card' } as const;
const asked = { LICENSE: 'your renewed driver’s license', MEDICAL_CARD: 'your new DOT medical card' } as const;
const hints = { LICENSE: 'Photograph the front, then the back. We remove photo details such as location before saving.',
  MEDICAL_CARD: 'Photograph every page of your new medical examiner’s certificate. We remove photo details such as location before saving.' } as const;
const noDraft = () => {};

/**
 * The page a renewal link opens, after the emailed code (designed as RenewDriverPhoneScreen): only the document Safety
 * asked for, scanned with the camera like at application, sent once. Safety checks it before it counts.
 */
export function DriverRenewal({ view: initial, focusHeading, onEnded }: { view: DriverRenewalView; focusHeading: boolean; onEnded: (message: string) => void }) {
  const [view, setView] = useState(initial);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focusHeading || view.sentAt) heading.current?.focus(); }, [focusHeading, view.sentAt]);
  // A link cancelled or run out while they were scanning ends the page (the scanner calls onEnded).
  const upload = useCallback(async (pages: string[]) => setView(await mutate<DriverRenewalView>('driver/renewal', 'POST', { pages })), []);
  const word = words[view.kind];
  if (view.sentAt) return <Card className="space-y-4 p-6 sm:p-8">
    <CheckCircle2 aria-hidden="true" className="size-8 text-success" />
    <h1 ref={heading} tabIndex={-1} className="text-2xl font-normal outline-none">Sent to Safety</h1>
    <p className="text-sm text-muted-foreground">Thank you. Safety received your {word}{view.document ? <> ({view.document.pageCount} {view.document.pageCount === 1 ? 'page' : 'pages'})</> : null} on <LocalTime iso={view.sentAt} format="date" /> and checks it before it counts. Your earlier {word} stays in your file. You can close this page.</p>
    <DriverTelegram />
  </Card>;
  return <Card className="space-y-6 p-6 sm:p-8">
    <div className="space-y-2">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-normal outline-none">Renew your {word}</h1>
      <p className="text-sm text-muted-foreground">UGEM Safety asked for {asked[view.kind]}. The link works until <LocalTime iso={view.expiresAt} format="date" />.</p>
    </div>
    {view.documentsEnabled ? <DocumentScanner kind={view.kind} required onEnded={onEnded} onDraft={noDraft} send={{ label: 'Send to Safety', hint: hints[view.kind], upload }} />
      : <p className="text-sm text-muted-foreground">Scanning isn’t available right now. Please contact Safety.</p>}
    <p className="text-[13px] text-muted-foreground">Safety checks it before it counts. Your earlier {word} stays in your file.</p>
  </Card>;
}
