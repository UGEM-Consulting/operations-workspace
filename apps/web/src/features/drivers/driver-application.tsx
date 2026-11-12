'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, RadioGroup, Select } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { ApiError, errorMessage, mutate, readApi } from '@/lib/client-api';
import { DOCUMENT_KINDS, documentLabels, licenseTypes, requiredDocuments, US_STATES, type DocumentKind } from '@/features/safety/types';
import { ConsentSigning, consentSectionId, type ConsentItem } from './consent-signing';
import { DocumentScanner, scannerId, type ScanDraft } from './document-scanner';
import { DriverRenewal, type DriverRenewalView } from './driver-renewal';
import { DriverCatchUp, type DriverCatchUpView } from './driver-catch-up';
import { DriverContract, type DriverContractView } from './driver-contract';
import { historyMissing, type DriverHistory } from './history-rules';
import { HistoryEditor, historySection, HistorySections, type HistoryEditing } from './history-section';
import { DriverTelegram } from './driver-telegram';

export interface DriverApplicationView { email: string; expiresAt: string; status: 'DRAFT' | 'SUBMITTED'; fields: Record<string, string>; version: number; ssnLast4: string | null; submittedAt: string | null; ssnAvailable: boolean;
  // From an API with document scanning; absent on an older one.
  documentsEnabled?: boolean; requiredDocuments?: DocumentKind[]; documents?: { id: string; kind: DocumentKind; subtype: string | null; pageCount: number; createdAt: string }[];
  // What Safety asked the driver to correct, from an API with screening.
  correction?: { message: string; requestedAt: string } | null;
  // The consent forms Safety published, from an API with consent forms.
  consents?: { required: boolean; consent: string; items: ConsentItem[] };
  // Address and work history, from an API with it (null until the driver adds any); absent on an older one.
  history?: DriverHistory | null }
const REQUIRED = ['legalFirstName', 'legalLastName', 'dateOfBirth', 'phone', 'addressLine1', 'city', 'state', 'zip', 'emergencyName', 'emergencyRelationship', 'emergencyPhone',
  'licenseNumber', 'licenseState', 'licenseClass', 'licenseExpiresOn'];
// Section 39: what Safety's paper packet asks (DriverApplicationMorePhoneScreen, DotQuestionsPhoneScreen).
const PACKET = ['otherNames', 'everHeldCdl', 'englishOk', 'examinerName', 'examinerRegistry', 'dotPositive', 'dotFollowUp'];
const FIELDS = [...REQUIRED, 'legalMiddleName', 'addressLine2', ...PACKET];
const YES_NO = [{ value: 'YES', label: 'Yes' }, { value: 'NO', label: 'No' }];
const isCdl = (licenseClass: string) => !!licenseClass && licenseClass !== 'DL';
/** The section 39 answers a submission needs, as the API's packetAnswersMissing decides them. */
function packetMissing(fields: Record<string, string>): string[] {
  return [...['englishOk', 'examinerName', 'examinerRegistry'], ...(fields.licenseClass === 'DL' ? ['everHeldCdl'] : []), ...(isCdl(fields.licenseClass) ? ['dotPositive', 'dotFollowUp'] : [])].filter(key => !fields[key]);
}
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
  // A renewal link opens the page for one document instead of the application (DriverRenewal).
  const [renewal, setRenewal] = useState<DriverRenewalView | null>(null);
  // A catch-up link (an existing driver, section 34) opens their photos and forms instead (DriverCatchUp).
  const [catchUp, setCatchUp] = useState<DriverCatchUpView | null>(null);
  // A contract link (section 39) opens the one acknowledgement, for the driver or the truck owner's signer (DriverContract).
  const [contract, setContract] = useState<DriverContractView | null>(null);
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [state, setState] = useState<'loading' | 'form' | 'renewal' | 'catchup' | 'contract' | 'closed'>('loading');
  const [closedMessage, setClosedMessage] = useState('');
  // Set when the link closed because Safety sent a newer one: when they sent it.
  const [newerSince, setNewerSince] = useState<string | null>(null);
  const ended = useCallback((end: string | ApiError) => { setClosedMessage(typeof end === 'string' ? end : end.message); setNewerSince(typeof end !== 'string' && end.reason?.code === 'NEWER_LINK' ? end.reason.since ?? '' : null); setState('closed'); }, []);
  // The link verified in this tab. Each new link (a fragment pasted into this tab, on a shared phone perhaps) needs its
  // own verification, so the previous driver's session never answers for it.
  const [verifiedToken, setVerifiedToken] = useState<string | null>(null);
  const [shownToken, setShownToken] = useState(token);
  if (shownToken !== token) { setShownToken(token); setView(null); setRenewal(null); setCatchUp(null); setContract(null); setPurpose(null); setState('loading'); setClosedMessage(''); }
  useEffect(() => { if (window.location.hash) window.history.replaceState(null, '', window.location.pathname); }, [token]);
  // Opening a link always verifies for that link, so an earlier session in this browser (another driver's, or a submitted
  // application) never answers for it. Without a link, the current session (a reload) opens the form, if there is one.
  const linked = token !== null && /^[a-f0-9]{64}$/.test(token);
  const malformed = token !== null && token !== '' && !linked;
  const verified = linked && verifiedToken === token;
  useEffect(() => {
    if (token === null || malformed || (linked && !verified)) return;
    let current = true;
    const showContract = () => readApi<DriverContractView>('driver/contract').then(result => { if (current) { setContract(result); setState('contract'); } });
    const showCatchUp = () => readApi<DriverCatchUpView>('driver/catch-up').then(result => { if (current) { setCatchUp(result); setState('catchup'); } },
      (error: unknown) => { if (purpose === null && error instanceof ApiError && error.status === 401) return showContract(); throw error; });
    const showRenewal = () => readApi<DriverRenewalView>('driver/renewal').then(result => { if (current) { setRenewal(result); setState('renewal'); } },
      (error: unknown) => { if (purpose === null && error instanceof ApiError && error.status === 401) return showCatchUp(); throw error; });
    // After a reload the session may be a renewal or catch-up link's, which the application refuses: then open that. A link
    // Safety replaced (NEWER_LINK) is an application link, so it keeps its reason instead.
    const open = purpose === 'CONTRACT' || purpose === 'CONTRACT_OWNER' ? showContract() : purpose === 'CATCH_UP' ? showCatchUp() : purpose === 'RENEWAL' ? showRenewal()
      : readApi<DriverApplicationView>('driver/application').then(result => { if (current) { setView(result); setState('form'); } },
        (error: unknown) => { if (purpose === null && error instanceof ApiError && error.status === 401 && error.reason?.code !== 'NEWER_LINK') return showRenewal(); throw error; });
    open.catch((error: unknown) => {
      if (!current) return;
      if (error instanceof ApiError && error.reason?.code === 'NEWER_LINK') { ended(error); return; }
      ended(error instanceof ApiError && error.status === 401 ? 'Open the link from Safety to continue. You’ll get a code by email.' : errorMessage(error, 'Unable to load your application.'));
    });
    return () => { current = false; };
  }, [token, malformed, linked, verified, purpose, ended]);
  if (token === null) return <p role="status" className="text-sm text-muted-foreground">Opening your application…</p>;
  if (malformed) return <Closed message="This link looks incomplete. Open the full link from Safety’s message." />;
  if (linked && !verified) return <VerifyDriver key={token} token={token} onVerified={next => { setPurpose(next); setVerifiedToken(token); }} />;
  if (state === 'loading') return <p role="status" className="text-sm text-muted-foreground">Opening your application…</p>;
  if (state === 'renewal' && renewal) return <DriverRenewal view={renewal} focusHeading={verified} onEnded={ended} />;
  if (state === 'catchup' && catchUp) return <DriverCatchUp view={catchUp} focusHeading={verified} onEnded={ended} />;
  if (state === 'contract' && contract) return <DriverContract view={contract} focusHeading={verified} onEnded={ended} />;
  if (state === 'closed' && newerSince !== null) return <NewerLink since={newerSince} />;
  if (state === 'closed' || !view) return <Closed message={closedMessage} />;
  return <DriverForm view={view} focusHeading={verified} onSaved={setView} onEnded={ended} />;
}

/** Safety replaced this link (designed as DriverNewerLinkPhoneScreen): the newest message has the one to use. */
function NewerLink({ since }: { since: string }) {
  return <Card className="space-y-4 p-6 sm:p-8">
    <h1 className="text-2xl font-normal">Safety sent you a newer link</h1>
    <Alert tone="info" title={since ? <>This link was replaced on <LocalTime iso={since} format="date" /></> : 'This link was replaced'}>
      <p>Open the newest message from UGEM Safety and use the link in it. Your answers, photos and signatures are saved.</p>
    </Alert>
    <p className="text-sm text-muted-foreground">You’ll confirm your email with a new code there, like before.</p>
    <p className="text-[13px] text-muted-foreground">Can’t find it? Ask Safety to send it again.</p>
  </Card>;
}

function Closed({ message }: { message: string }) {
  return <Card className="space-y-3 p-6 sm:p-8"><h1 className="text-2xl font-normal">Driver application</h1><p className="text-sm text-muted-foreground">{message}</p></Card>;
}

/** The first of these fields as they appear on the page, so focus moves top to bottom. */
function firstOnPage(form: HTMLFormElement | null, keys: string[]) {
  const elements = keys.map(key => form?.querySelector<HTMLElement>(`[name="${key}"]`)).filter((element): element is HTMLElement => !!element);
  return elements.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)[0];
}

type Purpose = 'APPLICATION' | 'RENEWAL' | 'CATCH_UP' | 'CONTRACT' | 'CONTRACT_OWNER';
function VerifyDriver({ token, onVerified }: { token: string; onVerified: (purpose: Purpose | null) => void }) {
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
    // An older API says nothing about the link, which then is an application link.
    try { const result = await mutate<{ purpose?: Purpose }>('driver/verify', 'POST', { challengeId: challenge, code: new FormData(event.currentTarget).get('code') }); onVerified(result?.purpose ?? 'APPLICATION'); }
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

function DriverForm({ view, focusHeading, onSaved, onEnded }: { view: DriverApplicationView; focusHeading: boolean; onSaved: (view: DriverApplicationView) => void; onEnded: (end: string | ApiError) => void }) {
  const form = useRef<HTMLFormElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Straight after verification, and on the confirmation after submitting, screen readers land on the heading rather than at the top of the page.
  useEffect(() => { if (focusHeading || view.status === 'SUBMITTED') heading.current?.focus(); }, [focusHeading, view.status]);
  const today = useToday();
  // Drivers who cross state lines must be 21.
  const adult = useSyncExternalStore(noSubscription, () => localDate(21), () => undefined);
  // Without SSN entry (no encryption key yet) the API refuses submission; say so instead of asking for a number.
  const ssnBlocked = !view.ssnAvailable && !view.ssnLast4;
  const [pending, setPending] = useState<'save' | 'submit' | null>(null);
  const [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The class chosen on the page decides whether a medical card is needed, before it is saved.
  const [licenseClass, setLicenseClass] = useState(view.fields.licenseClass ?? '');
  // The DOT answers decide whether the return-to-duty papers are needed, before they are saved.
  const [dot, setDot] = useState({ dotPositive: view.fields.dotPositive ?? '', dotFollowUp: view.fields.dotFollowUp ?? '' });
  const required = requiredDocuments({ licenseClass, ...dot }), kinds: DocumentKind[] = [...DOCUMENT_KINDS, ...(required.includes('RETURN_TO_DUTY') ? ['RETURN_TO_DUTY' as const] : [])];
  // Pages each scanner holds unsaved, and whether one is uploading.
  const [drafts, setDrafts] = useState<Partial<Record<DocumentKind, ScanDraft>>>({});
  const [scanErrors, setScanErrors] = useState<Partial<Record<DocumentKind, string>>>({});
  const onDraft = useCallback((kind: DocumentKind, draft: ScanDraft) => setDrafts(previous =>
    previous[kind]?.pages === draft.pages && previous[kind]?.busy === draft.busy ? previous : { ...previous, [kind]: draft }), []);
  const value = (key: string) => view.fields[key] ?? '';
  // The history is kept here while the driver works on it and sent whole with every save; an entry's own form opens in
  // place of the application, which stays on the page (hidden) so nothing typed there is lost.
  const historyEnabled = view.history !== undefined;
  const [history, setHistory] = useState<DriverHistory>(view.history ?? {});
  const [editing, setEditing] = useState<HistoryEditing | null>(null);
  const [editorError, setEditorError] = useState('');
  const [historyErrors, setHistoryErrors] = useState<string[]>([]);
  const now = today?.slice(0, 7);
  const scrollBack = useRef(0);
  function edit(next: HistoryEditing | null) {
    if (next) scrollBack.current = window.scrollY;
    setEditing(next); setEditorError('');
    requestAnimationFrame(() => window.scrollTo(0, next ? 0 : scrollBack.current));
  }
  if (view.status === 'SUBMITTED') return <Card className="space-y-4 p-6 sm:p-8">
    <CheckCircle2 aria-hidden="true" className="size-8 text-success" />
    <h1 ref={heading} tabIndex={-1} className="text-2xl font-normal outline-none">Application sent</h1>
    <p className="text-sm text-muted-foreground">Thank you. Safety received your application{view.submittedAt ? <> on <LocalTime iso={view.submittedAt} format="date" /></> : null} and will contact you about the next steps. You can close this page.</p>
    <DriverTelegram />
  </Card>;
  function read() {
    const data = new FormData(form.current!);
    const fields = Object.fromEntries(FIELDS.map(key => [key, String(data.get(key) ?? '').trim()]));
    return { fields, ssn: String(data.get('ssn') ?? '').trim() };
  }
  /** Saves (or submits) the answers and the history; true when it worked. `nextHistory` is a history an entry's form just changed. */
  async function save(submit: boolean, nextHistory?: DriverHistory): Promise<boolean> {
    if (pending) return false;
    const { fields, ssn } = read();
    const sentHistory = nextHistory ?? history;
    // Pages taken but not saved would be lost on submit; Save and finish later keeps answers only.
    const unsaved = kinds.filter(kind => drafts[kind]?.pages);
    if (submit) {
      const missing: Record<string, string> = Object.fromEntries([...REQUIRED.filter(key => !fields[key]), ...packetMissing(fields), ...(!ssn && !view.ssnLast4 && view.ssnAvailable ? ['ssn'] : [])].map(key => [key, 'Required']));
      // Guidance only; the API decides (age 21 to 100, license not expired).
      if (fields.dateOfBirth && adult && fields.dateOfBirth > adult) missing.dateOfBirth = 'You need to be 21 or older to drive between states.';
      if (fields.licenseExpiresOn && today && fields.licenseExpiresOn < today) missing.licenseExpiresOn = 'Your license has expired.';
      setErrors(missing);
      const unscanned = view.documentsEnabled ? requiredDocuments(fields).filter(kind => !unsaved.includes(kind) && !view.documents?.some(document => document.kind === kind)) : [];
      const problems: Partial<Record<DocumentKind, string>> = Object.fromEntries([...unsaved.map(kind => [kind, 'Save these pages before you submit, or remove them.']),
        ...unscanned.map(kind => [kind, 'Scan this document before you submit.'])]);
      setScanErrors(problems);
      // Forms come last on the page, after the answers and scans.
      const unsigned = view.consents?.required ? view.consents.items.filter(item => !item.current) : [];
      const historyGaps = historyEnabled && now ? historyMissing(sentHistory, now) : [];
      setHistoryErrors(historyGaps);
      if (Object.keys(missing).length || unsaved.length || unscanned.length || unsigned.length || historyGaps.length) {
        setFailed(true);
        // An unanswered question comes first; otherwise say what is wrong with the one answer (age, expired license).
        const issues = Object.values(missing);
        setMessage(issues.includes('Required') ? 'Answer every required question first.' : issues.length === 1 ? issues[0] : issues.length ? 'Check the highlighted answers.'
          : historyGaps.length ? 'Finish your address and work history first.' : unsaved.length ? `Save the pages you took for: ${names(unsaved)}.` : unscanned.length ? `Scan these documents first: ${names(unscanned)}.`
          : `Sign these forms first: ${unsigned.map(item => item.label.toLowerCase()).join(', ')}.`);
        // Answers come before the documents on the page, so the first answer in page order is the first problem.
        const answer = firstOnPage(form.current, Object.keys(missing)), scan = kinds.find(kind => problems[kind]);
        const section = historyGaps.map(historySection).find(Boolean);
        if (answer) answer.focus();
        else if (section) document.getElementById(section)?.focus();
        else if (scan) document.getElementById(scannerId(scan))?.focus();
        else document.getElementById(consentSectionId)?.focus();
        return false;
      }
      if (ssnBlocked) {
        setFailed(true);
        setMessage('Your application can’t be sent until Safety turns on SSN entry. Select Save and finish later; Safety will tell you when to come back.');
        return false;
      }
    }
    setPending(submit ? 'submit' : 'save'); setFailed(false); setMessage('');
    try {
      const saved = await mutate<DriverApplicationView>(submit ? 'driver/application/submit' : 'driver/application', submit ? 'POST' : 'PATCH', { version: view.version, fields, ...(ssn ? { ssn } : {}),
        ...(historyEnabled ? { history: sentHistory } : {}) });
      const ssnInput = form.current?.querySelector<HTMLInputElement>('[name="ssn"]');
      if (ssnInput) ssnInput.value = '';
      onSaved(saved); setErrors({}); setHistoryErrors([]);
      if (!submit) setMessage(unsaved.length ? `Answers saved. The pages you took for ${names(unsaved)} aren’t saved yet: select Save under each one.`
        : 'Saved. You can come back to this link until you submit.');
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'applicant-session') { onEnded(error); return false; }
      setFailed(true); setMessage(errorMessage(error, 'Unable to save. Your answers are still on this page.'));
      // A refused submission names the answers it needs (an age outside 18 to 100, an expired license, a missing answer):
      // mark them, with the API's explanation when it is about one answer, and move to the first.
      const refused = submit && error instanceof ApiError && error.status === 400 ? error : null, missing = refused?.missing ?? [];
      if (refused && missing.length) {
        const answers = missing.filter(key => !key.startsWith('history:'));
        setErrors(Object.fromEntries(answers.map(key => [key, missing.length === 1 ? refused.message : 'Required'])));
        setHistoryErrors(missing.filter(key => key.startsWith('history:')));
        const section = missing.map(historySection).find(Boolean), answer = firstOnPage(form.current, answers);
        if (answer) answer.focus(); else if (section) document.getElementById(section)?.focus();
      }
      return false;
    } finally { setPending(null); }
  }
  /** An entry's form saved: keep the new history and save the draft with it, so the entry is never only on the page. */
  async function saveEntry(next: DriverHistory) {
    setHistory(next); setEditorError('');
    if (await save(false, next)) edit(null);
    else setEditorError('Unable to save. Check your connection and try again; your entry is still here.');
  }
  const currentAddress = [value('addressLine1'), value('city'), [value('state'), value('zip')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const field = (key: string) => ({ name: key, defaultValue: value(key), error: errors[key], width: 'full' as const });
  const uploading = Object.values(drafts).some(draft => draft?.busy);
  return <>{editing && <HistoryEditor key={`${editing.kind}-${editing.id ?? 'new'}`} editing={editing} history={history} now={now} busy={pending === 'save'} error={editorError}
    onSave={next => void saveEntry(next)} onCancel={() => edit(null)} />}
  <form ref={form} hidden={!!editing} onSubmit={event => { event.preventDefault(); void save(true); }} className="space-y-6" noValidate>
    <div><h1 ref={heading} tabIndex={-1} className="text-2xl font-normal outline-none">Your driver application</h1>
      <p className="mt-1 text-sm text-muted-foreground">Signed in as {view.email}. Answers save when you select Save; the link works until <LocalTime iso={view.expiresAt} format="date" />.</p></div>
    {view.correction && <Alert tone="warning" title="Safety asked you to correct your application">
      <p className="whitespace-pre-wrap break-words">{view.correction.message}</p>
      <p className="mt-1">Make the changes, then select Submit application to send it again.</p></Alert>}
    <Section title="Your legal name" hint="As it appears on your license.">
      <div className="grid gap-4 sm:grid-cols-3">
        <Input label="First name" {...field('legalFirstName')} maxLength={100} autoComplete="given-name" />
        <Input label="Middle name" optional {...field('legalMiddleName')} maxLength={100} autoComplete="additional-name" />
        <Input label="Last name" {...field('legalLastName')} maxLength={100} autoComplete="family-name" />
      </div>
      <Input label="Other names you’ve used" optional {...field('otherNames')} maxLength={200} hint="A maiden name or an earlier legal name, if any." />
    </Section>
    <Section title="Date of birth and Social Security number" hint="Safety needs these to check your driving record. Your SSN is encrypted, and only UGEM Safety and administrators can see it.">
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
        <Input id="driver-email" label="Email" value={view.email} readOnly width="full" hint="The address Safety has for you." />
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
      {licenseClass === 'DL' && <RadioGroup name="everHeldCdl" label="Have you ever held a CDL?" hint="Including one that expired, was suspended or cancelled." defaultValue={value('everHeldCdl')} options={YES_NO} />}
      {errors.everHeldCdl && <p className="text-sm text-danger">{errors.everHeldCdl === 'Required' ? 'Answer this question.' : errors.everHeldCdl}</p>}
      <RadioGroup name="englishOk" label="Can you read and speak English well enough to talk with officers, read road signs and fill in reports?" defaultValue={value('englishOk')} options={YES_NO} />
      {errors.englishOk && <p className="text-sm text-danger">Answer this question.</p>}
    </Section>
    <Section title="Medical card" hint="From your DOT medical examiner’s certificate. Every driver needs one, pickup drivers too.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Medical examiner’s name" {...field('examinerName')} maxLength={100} />
        <Input label="National Registry number" {...field('examinerRegistry')} inputMode="numeric" maxLength={12} hint="Printed on the card, next to the examiner’s name." />
      </div>
    </Section>
    {isCdl(licenseClass) && <Section title="DOT drug and alcohol testing" hint="For CDL drivers. Answer truthfully: a Yes doesn’t end your application, but Safety needs your papers.">
      <RadioGroup name="dotPositive" label="In the last 2 years, did you test positive or refuse a DOT pre-employment test for a job you didn’t get?" defaultValue={dot.dotPositive}
        onChange={next => setDot(current => ({ ...current, dotPositive: next }))} options={YES_NO} />
      {errors.dotPositive && <p className="text-sm text-danger">Answer this question.</p>}
      <RadioGroup name="dotFollowUp" label="Are you on a return-to-duty or follow-up testing plan from a Substance Abuse Professional?" defaultValue={dot.dotFollowUp}
        onChange={next => setDot(current => ({ ...current, dotFollowUp: next }))} options={YES_NO} />
      {errors.dotFollowUp && <p className="text-sm text-danger">Answer this question.</p>}
      {required.includes('RETURN_TO_DUTY') && <Alert tone="info" title="Add your papers">Photograph your return-to-duty completion or your current follow-up plan under Documents. Only the Safety Director and your Safety Manager see them. Save your answers first.</Alert>}
    </Section>}
    {historyEnabled && <HistorySections history={history} onChange={setHistory} onEdit={edit} now={now} currentAddress={currentAddress} missing={historyErrors} Section={Section} />}
    {view.documentsEnabled && <Section title="Documents" hint="Use your phone’s camera. We remove photo details such as location before saving, and only UGEM Safety and administrators can see your documents.">
      {kinds.map(kind => <DocumentScanner key={kind} kind={kind} view={view} onSaved={onSaved} onEnded={onEnded} onDraft={onDraft} error={scanErrors[kind]}
        required={required.includes(kind)} />)}
    </Section>}
    {view.consents?.required && <div id={consentSectionId} tabIndex={-1} className="scroll-mt-20 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Section title="Consent forms" hint="Safety needs your consent before checking your driving record and background. Open and read each form in full, then sign it. You can download a signed copy afterwards.">
        <ConsentSigning view={view} onSaved={onSaved} onEnded={onEnded} editable={view.status === 'DRAFT'} />
      </Section></div>}
    <Notice message={message} error={failed} />
    <div className="flex flex-wrap gap-3 border-t pt-5">
      <Button type="submit" disabled={!!pending || uploading}>{pending === 'submit' ? 'Sending…' : uploading ? 'Saving scan…' : 'Submit application'}</Button>
      <Button type="button" variant="outline" disabled={!!pending} onClick={() => void save(false)}>{pending === 'save' ? 'Saving…' : 'Save and finish later'}</Button>
    </div>
    <PendingHint pending={!!pending} />
  </form></>;
}

function Section({ title, hint, id, children }: { title: string; hint?: string; id?: string; children: React.ReactNode }) {
  // An id lets a refused submission move focus to the section with the problem.
  return <Card id={id} tabIndex={id ? -1 : undefined} className="scroll-mt-20 space-y-4 p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-6"><div><h2 className="text-base font-semibold">{title}</h2>{hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}</div>{children}</Card>;
}
