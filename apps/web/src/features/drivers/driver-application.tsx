'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { ApiError, errorMessage, mutate, readApi } from '@/lib/client-api';
import { DOCUMENT_KINDS, documentLabels, licenseTypes, requiredDocuments, US_STATES, type DocumentKind } from '@/features/safety/types';
import { DocumentScanner, scannerId, type ScanDraft } from './document-scanner';

export interface DriverApplicationView { email: string; expiresAt: string; status: 'DRAFT' | 'SUBMITTED'; fields: Record<string, string>; version: number; ssnLast4: string | null; submittedAt: string | null; ssnAvailable: boolean;
  // From an API with document scanning; absent on an older one.
  documentsEnabled?: boolean; requiredDocuments?: DocumentKind[]; documents?: { id: string; kind: DocumentKind; subtype: string | null; pageCount: number; createdAt: string }[] }
const REQUIRED = ['legalFirstName', 'legalLastName', 'dateOfBirth', 'phone', 'addressLine1', 'city', 'state', 'zip', 'emergencyName', 'emergencyRelationship', 'emergencyPhone',
  'licenseNumber', 'licenseState', 'licenseClass', 'licenseExpiresOn'];
const FIELDS = [...REQUIRED, 'legalMiddleName', 'addressLine2'];
const states = US_STATES.map(state => ({ value: state, label: state }));
const names = (kinds: DocumentKind[]) => kinds.map(kind => documentLabels[kind].toLowerCase()).join(', ');

// Links are /driver#<token>. Browsers never send the fragment to servers, so the token stays out of request logs and
// Referer headers. The page holds it in memory and removes it from the address bar.
let captured = '';
function readFragment() { if (window.location.hash) captured = window.location.hash.slice(1); return captured; }
// A link pasted into an open /driver tab changes only the fragment, so listen for that too.
const subscribe = (changed: () => void) => { window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); };

// Today's local date (YYYY-MM-DD) for date-field limits. Read only in the browser: the server snapshot is undefined, so the
// server render and hydration never disagree about the date.
const noSubscription = () => () => {};
const localDate = (shiftYears = 0) => { const now = new Date(); now.setFullYear(now.getFullYear() - shiftYears);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
const useToday = () => useSyncExternalStore(noSubscription, () => localDate(), () => undefined);

/** The driver's application page: verify the email Safety has on file, then fill in and submit the application. */
export function DriverApplicationPage() {
  const token = useSyncExternalStore(subscribe, readFragment, () => null);
  const [view, setView] = useState<DriverApplicationView | null>(null);
  const [state, setState] = useState<'loading' | 'form' | 'closed'>('loading');
  const [closedMessage, setClosedMessage] = useState('');
  // The link verified in this tab. Each new link (a fragment pasted into this tab, on a shared phone perhaps) needs its
  // own verification, so the previous driver's session never answers for it.
  const [verifiedToken, setVerifiedToken] = useState<string | null>(null);
  const [shownToken, setShownToken] = useState(token);
  if (shownToken !== token) { setShownToken(token); setView(null); setState('loading'); setClosedMessage(''); }
  useEffect(() => { if (window.location.hash) window.history.replaceState(null, '', window.location.pathname); }, [token]);
  // Opening a link always verifies for that link, so an earlier session in this browser (another driver's, or a submitted
  // application) never answers for it. Without a link, the current session (a reload) opens the form, if there is one.
  const linked = token !== null && /^[a-f0-9]{64}$/.test(token);
  const malformed = token !== null && token !== '' && !linked;
  const verified = linked && verifiedToken === token;
  useEffect(() => {
    if (token === null || malformed || (linked && !verified)) return;
    let current = true;
    readApi<DriverApplicationView>('driver/application').then(result => { if (current) { setView(result); setState('form'); } }, (error: unknown) => {
      if (!current) return;
      setClosedMessage(error instanceof ApiError && error.status === 401 ? 'Open the application link from Safety to continue. You’ll get a code by email.' : errorMessage(error, 'Unable to load your application.'));
      setState('closed');
    });
    return () => { current = false; };
  }, [token, malformed, linked, verified]);
  if (token === null) return <p role="status" className="text-sm text-muted-foreground">Opening your application…</p>;
  if (malformed) return <Closed message="This link looks incomplete. Open the full link from Safety’s message." />;
  if (linked && !verified) return <VerifyDriver key={token} token={token} onVerified={() => setVerifiedToken(token)} />;
  if (state === 'loading') return <p role="status" className="text-sm text-muted-foreground">Opening your application…</p>;
  if (state === 'closed' || !view) return <Closed message={closedMessage} />;
  return <DriverForm view={view} focusHeading={verified} onSaved={setView} onEnded={message => { setClosedMessage(message); setState('closed'); }} />;
}

function Closed({ message }: { message: string }) {
  return <Card className="space-y-3 p-6 sm:p-8"><h1 className="text-2xl font-normal">Driver application</h1><p className="text-sm text-muted-foreground">{message}</p></Card>;
}

/** The first of these fields as they appear on the page, so focus moves top to bottom. */
function firstOnPage(form: HTMLFormElement | null, keys: string[]) {
  const elements = keys.map(key => form?.querySelector<HTMLElement>(`[name="${key}"]`)).filter((element): element is HTMLElement => !!element);
  return elements.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)[0];
}

function VerifyDriver({ token, onVerified }: { token: string; onVerified: () => void }) {
  const [challenge, setChallenge] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const code = useRef<HTMLInputElement>(null);
  useEffect(() => { if (challenge) code.current?.focus(); }, [challenge]);
  async function begin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFailed(false); setMessage('');
    try { const result = await mutate<{ challengeId: string; message: string }>('driver/begin', 'POST', { token, email: new FormData(event.currentTarget).get('email') }); setChallenge(result.challengeId); setMessage(result.message); }
    catch (error) { setFailed(true); setMessage(errorMessage(error, 'Verification is unavailable. Please try again.')); }
    finally { setBusy(false); }
  }
  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFailed(false); setMessage('');
    try { await mutate('driver/verify', 'POST', { challengeId: challenge, code: new FormData(event.currentTarget).get('code') }); onVerified(); }
    catch (error) { setFailed(true); setMessage(errorMessage(error, 'The code is wrong or has expired.')); }
    finally { setBusy(false); }
  }
  return <Card className="space-y-5 p-6 sm:p-8">
    <h1 className="text-2xl font-normal">Your driver application</h1>
    <p className="text-sm text-muted-foreground">Enter the email address you gave Safety. We’ll send an 8-digit code to it so we know it’s you.</p>
    {!challenge ? <form onSubmit={begin}><fieldset disabled={busy} className="space-y-4">
      <Input label="Email" name="email" type="email" required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} width="md" />
      <Button disabled={busy}>{busy ? 'Sending…' : 'Send code'}</Button></fieldset></form>
      : <form onSubmit={verify}><fieldset disabled={busy} className="space-y-4">
        <p className="text-sm text-muted-foreground">Check your inbox (and spam folder) for the code. It expires in 10 minutes.</p>
        <Input ref={code} label="Code" name="code" inputMode="numeric" pattern="[0-9]{8}" minLength={8} maxLength={8} autoComplete="one-time-code" required width="sm" />
        <div className="flex flex-wrap gap-3"><Button disabled={busy}>{busy ? 'Checking…' : 'Continue'}</Button>
          <Button type="button" variant="ghost" onClick={() => { setChallenge(''); setMessage(''); setFailed(false); }}>Use another email</Button></div></fieldset></form>}
    <PendingHint pending={busy} />
    <Notice message={message} error={failed} />
    <p className="text-sm text-muted-foreground">The link stops working once you submit, or if Safety sends you a new one.</p>
  </Card>;
}

function DriverForm({ view, focusHeading, onSaved, onEnded }: { view: DriverApplicationView; focusHeading: boolean; onSaved: (view: DriverApplicationView) => void; onEnded: (message: string) => void }) {
  const form = useRef<HTMLFormElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Straight after verification, and on the confirmation after submitting, screen readers land on the heading rather than at the top of the page.
  useEffect(() => { if (focusHeading || view.status === 'SUBMITTED') heading.current?.focus(); }, [focusHeading, view.status]);
  const today = useToday();
  const adult = useSyncExternalStore(noSubscription, () => localDate(18), () => undefined);
  // Without SSN entry (no encryption key yet) the API refuses submission; say so instead of asking for a number.
  const ssnBlocked = !view.ssnAvailable && !view.ssnLast4;
  const [pending, setPending] = useState<'save' | 'submit' | null>(null);
  const [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The class chosen on the page decides whether a medical card is needed, before it is saved.
  const [licenseClass, setLicenseClass] = useState(view.fields.licenseClass ?? '');
  // Pages each scanner holds unsaved, and whether one is uploading.
  const [drafts, setDrafts] = useState<Partial<Record<DocumentKind, ScanDraft>>>({});
  const [scanErrors, setScanErrors] = useState<Partial<Record<DocumentKind, string>>>({});
  const onDraft = useCallback((kind: DocumentKind, draft: ScanDraft) => setDrafts(previous =>
    previous[kind]?.pages === draft.pages && previous[kind]?.busy === draft.busy ? previous : { ...previous, [kind]: draft }), []);
  const value = (key: string) => view.fields[key] ?? '';
  if (view.status === 'SUBMITTED') return <Card className="space-y-4 p-6 sm:p-8">
    <CheckCircle2 aria-hidden="true" className="size-8 text-success" />
    <h1 ref={heading} tabIndex={-1} className="text-2xl font-normal outline-none">Application sent</h1>
    <p className="text-sm text-muted-foreground">Thank you. Safety received your application{view.submittedAt ? <> on <LocalTime iso={view.submittedAt} format="date" /></> : null} and will contact you about the next steps. You can close this page.</p>
  </Card>;
  function read() {
    const data = new FormData(form.current!);
    const fields = Object.fromEntries(FIELDS.map(key => [key, String(data.get(key) ?? '').trim()]));
    return { fields, ssn: String(data.get('ssn') ?? '').trim() };
  }
  async function save(submit: boolean) {
    if (pending) return;
    const { fields, ssn } = read();
    // Pages taken but not saved would be lost on submit; Save and finish later keeps answers only.
    const unsaved = DOCUMENT_KINDS.filter(kind => drafts[kind]?.pages);
    if (submit) {
      const missing: Record<string, string> = Object.fromEntries([...REQUIRED.filter(key => !fields[key]), ...(!ssn && !view.ssnLast4 && view.ssnAvailable ? ['ssn'] : [])].map(key => [key, 'Required']));
      // Guidance only; the API decides (age 18 to 100, license not expired).
      if (fields.dateOfBirth && adult && fields.dateOfBirth > adult) missing.dateOfBirth = 'You must be at least 18.';
      if (fields.licenseExpiresOn && today && fields.licenseExpiresOn < today) missing.licenseExpiresOn = 'Your license has expired.';
      setErrors(missing);
      const unscanned = view.documentsEnabled ? requiredDocuments(fields.licenseClass).filter(kind => !unsaved.includes(kind) && !view.documents?.some(document => document.kind === kind)) : [];
      const problems: Partial<Record<DocumentKind, string>> = Object.fromEntries([...unsaved.map(kind => [kind, 'Save these pages before you submit, or remove them.']),
        ...unscanned.map(kind => [kind, 'Scan this document before you submit.'])]);
      setScanErrors(problems);
      if (Object.keys(missing).length || unsaved.length || unscanned.length) {
        setFailed(true);
        // An unanswered question comes first; otherwise say what is wrong with the one answer (age, expired license).
        const issues = Object.values(missing);
        setMessage(issues.includes('Required') ? 'Answer every required question first.' : issues.length === 1 ? issues[0] : issues.length ? 'Check the highlighted answers.' : unsaved.length ? `Save the pages you took for: ${names(unsaved)}.` : `Scan these documents first: ${names(unscanned)}.`);
        // Answers come before the documents on the page, so the first answer in page order is the first problem.
        const answer = firstOnPage(form.current, Object.keys(missing)), scan = DOCUMENT_KINDS.find(kind => problems[kind]);
        if (answer) answer.focus();
        else if (scan) document.getElementById(scannerId(scan))?.focus();
        return;
      }
      if (ssnBlocked) {
        setFailed(true);
        setMessage('Your application can’t be sent until Safety turns on SSN entry. Select Save and finish later; Safety will tell you when to come back.');
        return;
      }
    }
    setPending(submit ? 'submit' : 'save'); setFailed(false); setMessage('');
    try {
      const saved = await mutate<DriverApplicationView>(submit ? 'driver/application/submit' : 'driver/application', submit ? 'POST' : 'PATCH', { version: view.version, fields, ...(ssn ? { ssn } : {}) });
      const ssnInput = form.current?.querySelector<HTMLInputElement>('[name="ssn"]');
      if (ssnInput) ssnInput.value = '';
      onSaved(saved); setErrors({});
      if (!submit) setMessage(unsaved.length ? `Answers saved. The pages you took for ${names(unsaved)} aren’t saved yet: select Save under each one.`
        : 'Saved. You can come back to this link until you submit.');
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'applicant-session') return onEnded(error.message);
      setFailed(true); setMessage(errorMessage(error, 'Unable to save. Your answers are still on this page.'));
      // A refused submission names the answers it needs (an age outside 18 to 100, an expired license, a missing answer):
      // mark them, with the API's explanation when it is about one answer, and move to the first.
      const refused = submit && error instanceof ApiError && error.status === 400 ? error : null, missing = refused?.missing ?? [];
      if (refused && missing.length) {
        setErrors(Object.fromEntries(missing.map(key => [key, missing.length === 1 ? refused.message : 'Required'])));
        firstOnPage(form.current, missing)?.focus();
      }
    } finally { setPending(null); }
  }
  const field = (key: string) => ({ name: key, defaultValue: value(key), error: errors[key], width: 'full' as const });
  const uploading = Object.values(drafts).some(draft => draft?.busy);
  return <form ref={form} onSubmit={event => { event.preventDefault(); void save(true); }} className="space-y-6" noValidate>
    <div><h1 ref={heading} tabIndex={-1} className="text-2xl font-normal outline-none">Your driver application</h1>
      <p className="mt-1 text-sm text-muted-foreground">Signed in as {view.email}. Answers save when you select Save; the link works until <LocalTime iso={view.expiresAt} format="date" />.</p></div>
    <Section title="Your legal name" hint="As it appears on your license.">
      <div className="grid gap-4 sm:grid-cols-3">
        <Input label="First name" {...field('legalFirstName')} maxLength={100} autoComplete="given-name" />
        <Input label="Middle name" optional {...field('legalMiddleName')} maxLength={100} autoComplete="additional-name" />
        <Input label="Last name" {...field('legalLastName')} maxLength={100} autoComplete="family-name" />
      </div>
    </Section>
    <Section title="Date of birth and Social Security number" hint="Safety needs these to check your driving record. Your SSN is encrypted, and only UGEM Safety staff and administrators can see it.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Date of birth" type="date" {...field('dateOfBirth')} max={adult} autoComplete="bday" />
        {view.ssnAvailable ? <Input label="Social Security number" name="ssn" error={errors.ssn} width="full" inputMode="numeric" autoComplete="off" maxLength={11} placeholder="123-45-6789"
          hint={view.ssnLast4 ? `On file, ending in ${view.ssnLast4}. Enter it again only to change it.` : undefined} />
          : <Alert tone="warning" title="SSN entry isn’t available yet"><p>{ssnBlocked ? 'Your application can’t be sent until Safety turns on SSN entry. Save the rest; Safety will tell you when to add it.' : `Your number ending in ${view.ssnLast4} is on file.`}</p></Alert>}
      </div>
    </Section>
    <Section title="Contact and home address">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Phone" type="tel" {...field('phone')} maxLength={40} autoComplete="tel" />
        <Input label="Email" value={view.email} readOnly width="full" hint="The address Safety has for you." />
      </div>
      <Input label="Street address" {...field('addressLine1')} maxLength={200} autoComplete="address-line1" />
      <Input label="Apartment, suite or unit" optional {...field('addressLine2')} maxLength={200} autoComplete="address-line2" />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Input label="City" {...field('city')} maxLength={100} autoComplete="address-level2" />
        <Select label="State" {...field('state')} placeholder="–" options={states} />
        <Input label="ZIP code" {...field('zip')} inputMode="numeric" maxLength={10} autoComplete="postal-code" />
      </div>
    </Section>
    <Section title="Emergency contact">
      <div className="grid gap-4 sm:grid-cols-3">
        <Input label="Name" {...field('emergencyName')} maxLength={200} />
        <Input label="Relationship" {...field('emergencyRelationship')} maxLength={50} placeholder="For example, spouse" />
        <Input label="Phone" type="tel" {...field('emergencyPhone')} maxLength={40} />
      </div>
    </Section>
    <Section title="Driver’s license">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="License number" {...field('licenseNumber')} maxLength={20} autoCapitalize="characters" spellCheck={false} />
        <Select label="Issuing state" {...field('licenseState')} placeholder="–" options={states} />
        <Select label="Class" {...field('licenseClass')} onChange={event => setLicenseClass(event.target.value)} placeholder="Choose a class" options={Object.entries(licenseTypes).map(([value, label]) => ({ value, label }))} />
        <Input label="Expiration date" type="date" {...field('licenseExpiresOn')} min={today} />
      </div>
    </Section>
    {view.documentsEnabled && <Section title="Documents" hint="Use your phone’s camera. We remove photo details such as location before saving, and only UGEM Safety staff and administrators can see your documents.">
      {DOCUMENT_KINDS.map(kind => <DocumentScanner key={kind} kind={kind} view={view} onSaved={onSaved} onEnded={onEnded} onDraft={onDraft} error={scanErrors[kind]}
        required={requiredDocuments(licenseClass).includes(kind)} />)}
    </Section>}
    <Notice message={message} error={failed} />
    <div className="flex flex-wrap gap-3 border-t pt-5">
      <Button type="submit" disabled={!!pending || uploading}>{pending === 'submit' ? 'Sending…' : uploading ? 'Saving scan…' : 'Submit application'}</Button>
      <Button type="button" variant="outline" disabled={!!pending} onClick={() => void save(false)}>{pending === 'save' ? 'Saving…' : 'Save and finish later'}</Button>
    </div>
    <PendingHint pending={!!pending} />
  </form>;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return <Card className="space-y-4 p-5 sm:p-6"><div><h2 className="text-base font-semibold">{title}</h2>{hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}</div>{children}</Card>;
}
