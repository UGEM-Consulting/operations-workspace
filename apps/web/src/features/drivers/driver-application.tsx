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
import { licenseTypes, US_STATES } from '@/features/safety/types';

export interface DriverApplicationView { email: string; expiresAt: string; status: 'DRAFT' | 'SUBMITTED'; fields: Record<string, string>; version: number; ssnLast4: string | null; submittedAt: string | null; ssnAvailable: boolean }
const REQUIRED = ['legalFirstName', 'legalLastName', 'dateOfBirth', 'phone', 'addressLine1', 'city', 'state', 'zip', 'emergencyName', 'emergencyRelationship', 'emergencyPhone',
  'licenseNumber', 'licenseState', 'licenseClass', 'licenseExpiresOn'];
const FIELDS = [...REQUIRED, 'legalMiddleName', 'addressLine2'];
const states = US_STATES.map(state => ({ value: state, label: state }));

// Links are /driver#<token>. Browsers never send the fragment to servers, so the token stays out of request logs and
// Referer headers. The page holds it in memory and removes it from the address bar.
let captured = '';
function readFragment() { if (window.location.hash) captured = window.location.hash.slice(1); return captured; }
// A link pasted into an open /driver tab changes only the fragment, so listen for that too.
const subscribe = (changed: () => void) => { window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); };

/** The driver's application page: verify the email Safety has on file, then fill in and submit the application. */
export function DriverApplicationPage() {
  const token = useSyncExternalStore(subscribe, readFragment, () => null);
  const [view, setView] = useState<DriverApplicationView | null>(null);
  const [state, setState] = useState<'loading' | 'form' | 'closed'>('loading');
  const [closedMessage, setClosedMessage] = useState('');
  const [verified, setVerified] = useState(false);
  useEffect(() => { if (window.location.hash) window.history.replaceState(null, '', window.location.pathname); }, [token]);
  // Opening a link always verifies for that link, so an earlier session in this browser (another driver's, or a submitted
  // application) never answers for it. Without a link, the current session (a reload) opens the form, if there is one.
  const linked = token !== null && /^[a-f0-9]{64}$/.test(token);
  const load = useCallback(() => readApi<DriverApplicationView>('driver/application').then(result => { setView(result); setState('form'); }, (error: unknown) => {
    setClosedMessage(error instanceof ApiError && error.status === 401 ? 'Open the application link from Safety to continue. You’ll get a code by email.' : errorMessage(error, 'Unable to load your application.'));
    setState('closed');
  }), []);
  useEffect(() => { if (token !== null && (!linked || verified)) void load(); }, [token, linked, verified, load]);
  if (token === null) return <p role="status" className="text-sm text-muted-foreground">Opening your application…</p>;
  if (linked && !verified) return <VerifyDriver token={token} onVerified={() => setVerified(true)} />;
  if (state === 'loading') return <p role="status" className="text-sm text-muted-foreground">Opening your application…</p>;
  if (state === 'closed' || !view) return <Card className="space-y-3 p-6 sm:p-8"><h1 className="text-2xl font-normal">Driver application</h1><p className="text-sm text-muted-foreground">{closedMessage}</p></Card>;
  return <DriverForm view={view} onSaved={setView} onEnded={message => { setClosedMessage(message); setState('closed'); }} />;
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

function DriverForm({ view, onSaved, onEnded }: { view: DriverApplicationView; onSaved: (view: DriverApplicationView) => void; onEnded: (message: string) => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState<'save' | 'submit' | null>(null);
  const [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const value = (key: string) => view.fields[key] ?? '';
  if (view.status === 'SUBMITTED') return <Card className="space-y-4 p-6 sm:p-8">
    <CheckCircle2 aria-hidden="true" className="size-8 text-success" />
    <h1 className="text-2xl font-normal">Application sent</h1>
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
    if (submit) {
      const missing = Object.fromEntries([...REQUIRED.filter(key => !fields[key]), ...(!ssn && !view.ssnLast4 ? ['ssn'] : [])].map(key => [key, 'Required']));
      setErrors(missing);
      if (Object.keys(missing).length) {
        setFailed(true); setMessage('Answer every required question first.');
        form.current?.querySelector<HTMLElement>(`[name="${Object.keys(missing)[0]}"]`)?.focus();
        return;
      }
    }
    setPending(submit ? 'submit' : 'save'); setFailed(false); setMessage('');
    try {
      const saved = await mutate<DriverApplicationView>(submit ? 'driver/application/submit' : 'driver/application', submit ? 'POST' : 'PATCH', { version: view.version, fields, ...(ssn ? { ssn } : {}) });
      const ssnInput = form.current?.querySelector<HTMLInputElement>('[name="ssn"]');
      if (ssnInput) ssnInput.value = '';
      onSaved(saved); setErrors({});
      if (!submit) setMessage('Saved. You can come back to this link until you submit.');
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'applicant-session') return onEnded(error.message);
      setFailed(true); setMessage(errorMessage(error, 'Unable to save. Your answers are still on this page.'));
    } finally { setPending(null); }
  }
  const field = (key: string) => ({ name: key, defaultValue: value(key), error: errors[key], width: 'full' as const });
  return <form ref={form} onSubmit={event => { event.preventDefault(); void save(true); }} className="space-y-6" noValidate>
    <div><h1 className="text-2xl font-normal">Your driver application</h1>
      <p className="mt-1 text-sm text-muted-foreground">Signed in as {view.email}. Answers save when you select Save; the link works until <LocalTime iso={view.expiresAt} format="date" />.</p></div>
    <Section title="Your legal name" hint="As it appears on your license.">
      <div className="grid gap-4 sm:grid-cols-3">
        <Input label="First name" {...field('legalFirstName')} maxLength={100} autoComplete="given-name" />
        <Input label="Middle name" optional {...field('legalMiddleName')} maxLength={100} autoComplete="additional-name" />
        <Input label="Last name" {...field('legalLastName')} maxLength={100} autoComplete="family-name" />
      </div>
    </Section>
    <Section title="Date of birth and Social Security number" hint="Safety needs these to check your driving record. Your SSN is encrypted and only Safety can see it.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Date of birth" type="date" {...field('dateOfBirth')} autoComplete="bday" />
        {view.ssnAvailable ? <Input label="Social Security number" name="ssn" error={errors.ssn} width="full" inputMode="numeric" autoComplete="off" maxLength={11} placeholder="123-45-6789"
          hint={view.ssnLast4 ? `On file, ending in ${view.ssnLast4}. Enter it again only to change it.` : undefined} />
          : <Alert tone="warning" title="SSN entry isn’t available yet"><p>Save the rest; Safety will tell you when to add it.</p></Alert>}
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
        <Select label="Class" {...field('licenseClass')} placeholder="Choose a class" options={Object.entries(licenseTypes).map(([value, label]) => ({ value, label }))} />
        <Input label="Expiration date" type="date" {...field('licenseExpiresOn')} />
      </div>
      <p className="text-sm text-muted-foreground">You’ll upload photos of your license and other documents in a later step.</p>
    </Section>
    <Notice message={message} error={failed} />
    <div className="flex flex-wrap gap-3 border-t pt-5">
      <Button type="submit" disabled={!!pending}>{pending === 'submit' ? 'Sending…' : 'Submit application'}</Button>
      <Button type="button" variant="outline" disabled={!!pending} onClick={() => void save(false)}>{pending === 'save' ? 'Saving…' : 'Save and finish later'}</Button>
    </div>
    <PendingHint pending={!!pending} />
  </form>;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return <Card className="space-y-4 p-5 sm:p-6"><div><h2 className="text-base font-semibold">{title}</h2>{hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}</div>{children}</Card>;
}
