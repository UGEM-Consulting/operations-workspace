'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Calendar, KeyRound, Link2, Pencil, TriangleAlert } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/feedback';
import { Input, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { useLeaveGuard } from '@/components/shell-context';
import { middayIso } from '@/lib/navigation';
import { PaperScanActions } from './paper-scan';
import { SignIn } from './sign-in';
import { signInItems } from './sign-in-status';
import { assists, supportName, underMc, type MemberProfile, type PaperworkList, type PaperworkRow } from './types';

type LinkResult = { memberId: string; name: string; email?: string; url?: string; problem?: string };
const name = (row: { firstName: string; lastName: string }) => `${row.firstName} ${row.lastName}`;

function DocBadge({ doc }: { doc: PaperworkRow['nda'] }) {
  return doc.state === 'PAPER' ? <Badge label="Paper on file" tone="neutral" /> : doc.state === 'SIGNED' ? <Badge label="Signed" tone="success" /> : <Badge label="To sign" tone="warning" />;
}
/** Links are shown once, for the manager to send: copying them is the only way to get them. */
function LinksDialog({ results, onClose }: { results: LinkResult[]; onClose: () => void }) {
  const made = results.filter(item => item.url), refused = results.filter(item => item.problem);
  useLeaveGuard(made.length ? () => window.confirm('Leave without sending these links? They can’t be shown again.') : null);
  useEffect(() => {
    if (!made.length) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [made.length]);
  return <Dialog open onClose={onClose} size="lg" protectChanges={false} closeLabel={made.length ? 'I’ve sent them' : 'Close'} title={made.length ? 'Send these links now' : 'No links created'}
    description={made.length ? 'Each link is shown once and lasts 14 days. Send each one only to that person: it works only with the personal email on their record.' : undefined}>
    <div className="space-y-4">
      {made.length > 0 && <Alert tone="warning" title="These disappear when you close this"><p>If one gets lost, create a new one on that person’s page. The old one stops working.</p></Alert>}
      {made.map(item => <div key={item.memberId} className="space-y-1">
        <p className="text-sm font-medium">{item.name} <span className="font-normal text-muted-foreground">· {item.email}</span></p>
        <div className="flex items-center gap-2"><p className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-[13px]" title="Copy this link">{item.url}</p>
          <CopyButton text={item.url!} label={`Copy link for ${item.name}`} size="sm" /></div></div>)}
      {refused.map(item => <Alert key={item.memberId} tone="info" title={item.name}><p>{item.problem}</p></Alert>)}
    </div>
  </Dialog>;
}
function useLinks() {
  const [results, setResults] = useState<LinkResult[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function create(memberIds: string[]) {
    setBusy(true); setError('');
    try { setResults((await mutate<{ items: LinkResult[] }>('dispatch/paperwork/links', 'POST', { memberIds })).items); }
    catch (failure) { setError(errorMessage(failure, 'Unable to create the links. Please try again.')); }
    finally { setBusy(false); }
  }
  return { results, setResults, busy, error, create };
}

/** The Paperwork tab of Dispatch › Dispatchers: everyone added by hand with something outstanding. */
export function PaperworkTable({ list, search }: { list: PaperworkList; search: string }) {
  const router = useRouter(), links = useLinks();
  const [picked, setPicked] = useState<string[]>([]);
  const term = search.toLowerCase();
  const rows = list.items.filter(row => row.state !== 'FINISHED' && `${name(row)} ${row.mc ?? ''} ${row.team ?? ''}`.toLowerCase().includes(term));
  const creatable = rows.filter(row => row.state === 'TO_CREATE');
  const state = (row: PaperworkRow) => {
    if (row.state === 'WAITING') return row.canReview ? <Button asChild size="sm"><Link href={`/dispatch/dispatchers/${row.id}/paperwork`}>Review</Link></Button> : <Badge label="With their manager" tone="info" />;
    if (row.state === 'NO_EMAIL') return <Button asChild size="sm" variant="outline"><Link href={`/dispatch/dispatchers/${row.id}`}>Add email</Link></Button>;
    if (row.state === 'TIME_ENDED') return row.canReview ? <MoreTimeButton memberId={row.id} firstName={row.firstName} timeEndedAt={row.timeEndedAt} returnEmail={row.returnEmail} /> : <Badge label="Time ended" tone="warning" />;
    if (row.state === 'TO_CREATE') return <Badge label="Link to create" tone="neutral" />;
    if (row.state === 'CHANGES_REQUESTED') return <Badge label="Changes asked" tone="warning" />;
    return <Badge label={row.state === 'SENT' ? 'Link sent' : 'In progress'} tone="info" />;
  };
  const linkText = (row: PaperworkRow) => row.state === 'TIME_ENDED' && row.timeEndedAt ? <>Started, time ended <LocalTime iso={row.timeEndedAt} format="date" /></> : row.state === 'NO_EMAIL' ? 'No personal email' : row.state === 'TO_CREATE' ? (row.linkExpired ? 'Expired' : 'Not created') : row.state === 'SENT' ? 'Sent' : row.state === 'OPENED' ? 'Opened' : 'Started';
  return <>
    <div className="grid grid-cols-2 gap-4 p-4 sm:p-5 lg:grid-cols-4">{[['Link to create', list.counts.toCreate], ['Link sent', list.counts.sent], ['Waiting for you', list.counts.waiting], ['Paperwork finished', list.counts.finished]].map(([label, value]) => <div key={label} className="rounded-lg border bg-card p-4 shadow-xs"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p></div>)}</div>
    <Table caption="Dispatchers with outstanding paperwork" className="border-t border-border" rows={rows} rowKey={row => row.id} columns={[
      { key: 'pick', label: 'Select', srOnly: true, cell: row => row.state === 'TO_CREATE' ? <input type="checkbox" className="size-4 accent-primary" aria-label={`Select ${name(row)}`} checked={picked.includes(row.id)} onChange={event => setPicked(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id))} /> : null },
      { key: 'name', label: 'Dispatcher', primary: true, cell: row => <Link href={`/dispatch/dispatchers/${row.id}`} className="block rounded-sm hover:underline focus-visible:outline-2"><Person name={name(row)} secondary={row.position === 'SUPPORT' ? `${supportName(row)} for ${assists(row)}` : (underMc(row.mc) ? `${row.mc} · ${row.team ?? 'Independent'}` : 'No MC yet')} /></Link> },
      { key: 'nda', label: 'NDA', cell: row => <DocBadge doc={row.nda} /> }, { key: 'sop', label: 'SOP', cell: row => <DocBadge doc={row.sop} /> },
      { key: 'link', label: 'Link', hideBelow: 'lg', muted: true, cell: linkText }, { key: 'status', label: 'Status', cell: state }]}
      empty={<EmptyState compact title={term ? 'Nothing matches this search' : 'Nothing outstanding'} description={term ? 'Try another search.' : 'Everyone added by hand has finished their paperwork, or nobody has been added yet.'} />}
      footer={creatable.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-[13px] text-muted-foreground">{picked.length} selected</p>
        <span className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => setPicked(picked.length === creatable.length ? [] : creatable.map(row => row.id))}>{picked.length === creatable.length ? 'Clear' : `Select all ${creatable.length}`}</Button>
          <Button size="sm" disabled={!picked.length || links.busy || picked.length > 100} onClick={() => void links.create(picked)}><Link2 aria-hidden="true" className="size-4" />{links.busy ? 'Creating…' : `Create ${picked.length} ${picked.length === 1 ? 'link' : 'links'}`}</Button></span></div>} />
    {picked.length > 100 && <p className="px-5 pb-3 text-[13px] text-warning">Create up to 100 links at a time.</p>}
    <div className="px-5"><Notice message={links.error} error /></div>
    {links.results && <LinksDialog results={links.results} onClose={() => { links.setResults(null); setPicked([]); router.refresh(); }} />}
  </>;
}

/** The dispatcher's page, for someone added by hand: create their link. */
/** Creates someone's catch-up link from a button or a menu item: what to call it, how to start it, and the result to show. */
export function useCatchUpLink(member: MemberProfile) {
  const router = useRouter(), links = useLinks();
  return { label: links.busy ? 'Creating…' : member.existing?.catchUp && !member.existing.catchUp.started ? 'Create a new link' : 'Create catch-up link', busy: links.busy, create: () => void links.create([member.id]),
    result: <>{links.error && <span role="alert" className="text-[13px] text-danger">{links.error}</span>}
      {links.results && <LinksDialog results={links.results} onClose={() => { links.setResults(null); router.refresh(); }} />}</> };
}

/** Someone who started and ran out of time. The workspace doesn't message them, so the manager tells them. */
function MoreTimeButton({ memberId, firstName, timeEndedAt, returnEmail }: { memberId: string; firstName: string; timeEndedAt?: string | null; returnEmail?: string | null }) {
  const router = useRouter(), toast = useToast();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [newEnd, setNewEnd] = useState('');
  async function give() {
    if (busy) return;
    setBusy(true); setError('');
    try { await mutate(`dispatch/members/${memberId}/more-time`, 'POST', {}); setOpen(false); toast({ title: `${firstName} has 14 more days`, description: 'Tell them they can return with their reference and a new code.' }); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to give more time. Please try again.')); }
    finally { setBusy(false); }
  }
  return <><Button size="sm" variant="outline" onClick={() => { setNewEnd(new Date(Date.now() + 14 * 86400_000).toISOString()); setError(''); setOpen(true); }}>Give more time</Button>
    {open && <Dialog open onClose={() => setOpen(false)} busy={busy} title={`Give ${firstName} 14 more days?`} description={`${firstName} started their paperwork, but their time to finish it ended${timeEndedAt ? ` ${new Date(timeEndedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}.`}
      actions={<Button disabled={busy} onClick={() => void give()}><Calendar aria-hidden="true" className="size-4" />{busy ? 'Saving…' : 'Give 14 more days'}</Button>}>
      <div className="space-y-4">
        <DescriptionList layout="rows" items={[{ label: 'Kept', value: 'Their answers, photos and signatures' }, { label: 'New end date', value: <LocalTime iso={newEnd} format="date" /> }, { label: 'How they return', value: returnEmail ? `Their reference and a new code sent to ${returnEmail}` : 'Their reference and a new code' }]} />
        <Alert tone="info" title={`Tell ${firstName} yourself`}><p>The workspace doesn’t message them. Send them their reference, which is on their page.</p></Alert>
        <Notice message={error} error /><PendingHint pending={busy} />
      </div>
    </Dialog>}</>;
}

/** What a manager recorded for someone added by hand, and what is still outstanding. */
export function ExistingPaperworkCard({ member }: { member: MemberProfile }) {
  const existing = member.existing!, catchUp = existing.catchUp, signed = (kind: string) => catchUp?.signed.find(item => item.kind === kind);
  const paper = (kind: string) => existing.paper.find(item => item.kind === kind);
  const finished = !!existing.acceptedAt;
  const doc = (label: string, kind: string) => {
    const onPaper = paper(kind), done = signed(kind);
    // With storage, a paper copy shows its scan or Add scan (PaperScanAddScreen, PaperScanProfileScreen).
    const scans = onPaper && existing.paperScans;
    return { label, action: scans ? <PaperScanActions member={member} paper={onPaper} /> : null, detail: onPaper ? <><div>Signed on paper <LocalTime iso={middayIso(onPaper.signedOn)} format="date" />. Recorded by {onPaper.recordedBy}.{scans && !onPaper.scan ? ' No scan yet.' : ''}</div>
      {onPaper.scan && <div className="text-[13px] leading-5 text-muted-foreground">Scan added by {onPaper.scan.uploadedBy} on <LocalTime iso={onPaper.scan.createdAt} format="date" /> · {onPaper.scan.pageCount} {onPaper.scan.pageCount === 1 ? 'page' : 'pages'}</div>}</> : done ? <>{kind === 'CONTACT_LIST' ? 'Acknowledged' : 'Signed'} in the workspace <LocalTime iso={done.signedAt} format="date" />.</> : kind === 'CONTACT_LIST' ? 'Acknowledged in the workspace.' : 'The current version, in the workspace.',
      status: onPaper ? <Badge label="Paper on file" tone="neutral" /> : done ? <Badge label={kind === 'CONTACT_LIST' ? 'Acknowledged' : 'Signed'} tone="success" /> : <Badge label={kind === 'CONTACT_LIST' ? 'To acknowledge' : 'To sign'} tone="warning" /> };
  };
  // Only documents that exist to sign, or that are on file on paper.
  const docs = ([['NDA', 'NDA'], ['SOP', 'SOP'], ['Contact list', 'CONTACT_LIST']] as const).filter(([, kind]) => existing.published.includes(kind) || paper(kind) || signed(kind)).map(([label, kind]) => doc(label, kind));
  const rows = [...docs,
    { label: 'Photos', action: null, detail: 'Selfie and selfie with ID.', status: finished ? <Badge label="Added" tone="success" /> : <Badge label="To add" tone="warning" /> },
    { label: 'Personal details', action: null, detail: 'Legal name, American name and Telegram.', status: finished ? <Badge label="Confirmed" tone="success" /> : <Badge label="To confirm" tone="warning" /> }];
  return <Card><CardHeader title="Paperwork" description={finished ? <>Finished <LocalTime iso={existing.acceptedAt!} format="date" />.</> : `${member.firstName} started before the workspace, so there’s no application.`}
    actions={catchUp?.status && ['SUBMITTED', 'RESUBMITTED'].includes(catchUp.status) && catchUp.canReview ? <Button asChild size="sm"><Link href={`/dispatch/dispatchers/${member.id}/paperwork`}>Review</Link></Button> : undefined} />
    <Table className="mt-3 border-t border-border" caption={`${member.firstName} ${member.lastName}’s paperwork`} rows={rows} rowKey={row => row.label} columns={[{ key: 'item', label: 'Item', primary: true, cell: row => row.label }, { key: 'detail', label: 'Detail', cell: row => row.detail }, { key: 'status', label: 'Status', cell: row => row.status },
      ...(existing.paperScans ? [{ key: 'action', label: 'Actions', srOnly: true, align: 'right' as const, action: true, cell: (row: typeof rows[number]) => row.action }] : [])]}
      footer={<div className="space-y-2 text-[13px] text-muted-foreground">
        {!finished && !existing.personalEmail && <p className="flex items-center gap-1.5 text-warning"><TriangleAlert aria-hidden="true" className="size-3.5" />Add their personal email to create a catch-up link.</p>}
        {catchUp && !catchUp.started && !finished && <p>Link sent. It works until <LocalTime iso={catchUp.expiresAt} format="date" />.</p>}
        {catchUp?.timeEndedAt && !finished && <div className="flex flex-wrap items-center justify-between gap-2"><p className="flex items-center gap-1.5 text-warning"><TriangleAlert aria-hidden="true" className="size-3.5" />Their time to finish ended <LocalTime iso={catchUp.timeEndedAt} format="date" />.</p>
          {catchUp.canReview && <MoreTimeButton memberId={member.id} firstName={member.firstName} timeEndedAt={catchUp.timeEndedAt} returnEmail={catchUp.returnEmail} />}</div>}
        {catchUp?.reference && !finished && <p className="flex flex-wrap items-center gap-2"><KeyRound aria-hidden="true" className="size-3.5" />They’ve started. If they lost their place, they can return with this reference and a new code: <span className="break-all font-mono">{catchUp.reference}</span> <CopyButton text={catchUp.reference} label="Copy reference" size="sm" variant="ghost" /></p>}
        <p>Added by {existing.addedBy} <LocalTime iso={existing.createdAt} format="date" />{existing.sourceName ? ` from ${existing.sourceName}` : ''}.</p></div>} />
  </Card>;
}

/** Accounts recorded by a manager, shown in the rail, with the way to correct everything they recorded. Once their application has a Telegram answer, that's the one shown, so it isn't offered here. */
export function ExistingAccountsCard({ member, open, admin = false }: { member: MemberProfile; open: boolean; admin?: boolean }) {
  const router = useRouter(), toast = useToast(), existing = member.existing!;
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  // An administrator may correct the name of someone with no application (CorrectNameByHandScreen); a reason is needed when it changes.
  const nameEditable = admin && !member.details, [names, setNames] = useState({ firstName: member.firstName, lastName: member.lastName });
  const renamed = nameEditable && (names.firstName.trim() !== member.firstName || names.lastName.trim() !== member.lastName);
  // The record's version once the name is saved, so a retry after the other details failed doesn't send the name again.
  const [renamedVersion, setRenamedVersion] = useState<number | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const { firstName, lastName, nameReason, ...data } = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
    setBusy(true); setError('');
    try {
      let version = renamedVersion ?? member.version, nameSaved = renamedVersion !== null;
      if (renamed && !nameSaved) { version = (await mutate<{ version: number }>(`dispatch/members/${member.id}/correct`, 'POST', { version, reason: nameReason, ...(firstName.trim() !== member.firstName ? { firstName } : {}), ...(lastName.trim() !== member.lastName ? { lastName } : {}) }))!.version; setRenamedVersion(version); nameSaved = true; }
      try { await mutate(`dispatch/members/${member.id}/existing`, 'PATCH', { version, ...data }); }
      catch (failure) { if (nameSaved) { setError(errorMessage(failure, 'Their name was saved, but the other details weren’t. Your entries have been kept: try again.')); router.refresh(); return; } throw failure; }
      setRenamedVersion(null); setEditing(false); toast({ title: 'Details saved' }); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  const paperOn = (kind: string) => existing.paper.find(item => item.kind === kind)?.signedOn ?? '';
  // Someone added as Left (LeftRecordScreen): the accounts they had, as recorded.
  const addedLeft = member.status === 'LEFT' && !!existing.addedAsLeft;
  return <Card><CardHeader title={addedLeft ? 'Accounts they had' : 'Accounts'} description={addedLeft ? (existing.sourceName ? 'Recorded from the file.' : 'Recorded by a manager.') : undefined} actions={open && <Button size="sm" variant="ghost" onClick={() => { setEditing(true); setError(''); }}><Pencil aria-hidden="true" className="size-3.5" />Edit</Button>} />
    <CardBody className="space-y-3">
      <DescriptionList layout="rows" stacked items={[{ label: 'Company email', value: existing.companyEmail, emptyLabel: member.position === 'SUPPORT' ? 'None of their own' : 'Not recorded' }, { label: 'RingCentral number', value: existing.ringCentralNumber, mono: true, emptyLabel: 'Not recorded' },
        ...(existing.ringCentralExtension ? [{ label: 'Extension', value: existing.ringCentralExtension, mono: true }] : []),
        // Load board sign-ins show in the Load boards card once the API has seats (section 33).
        ...(member.loadBoardSeats ? [] : [{ label: 'DAT sign-in', value: existing.datEmail && <SignIn email={existing.datEmail} others={member.sharedSignIns?.dat} />, emptyLabel: 'Not recorded' }, { label: 'Truckstop sign-in', value: existing.truckstopEmail && <SignIn email={existing.truckstopEmail} others={member.sharedSignIns?.truckstop} />, emptyLabel: 'Not recorded' }]), ...signInItems(member)]} />
      {!addedLeft && <p className="text-[13px] leading-5 text-muted-foreground">Recorded by a manager, not from IT setup. IT sees these when {member.firstName} leaves.</p>}
    </CardBody>
    {editing && <Dialog open onClose={() => setEditing(false)} busy={busy} size="lg" title={`Edit ${member.firstName} ${member.lastName}’s recorded details`} description="What you know now. Nobody is messaged." actions={<Button form="edit-existing" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save details'}</Button>}>
      <form id="edit-existing" onSubmit={submit} className="space-y-4"><fieldset disabled={busy} className="min-w-0 space-y-4">
        {nameEditable && <Card><CardHeader title="Name" description={`Administrators only.${existing.sourceName ? ` Recorded from ${existing.sourceName}.` : ''}`} /><CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input name="firstName" label="First name" required maxLength={100} width="full" value={names.firstName} onChange={event => setNames(current => ({ ...current, firstName: event.target.value }))} />
            <Input name="lastName" label="Last name" required maxLength={100} width="full" value={names.lastName} onChange={event => setNames(current => ({ ...current, lastName: event.target.value }))} hint={names.lastName.trim() !== member.lastName ? `Was: ${member.lastName}` : undefined} />
          </div>
          {renamed && <Textarea name="nameReason" label="Why the name changed" required maxLength={500} rows={2} hint="Kept in their history." />}
        </CardBody></Card>}
        <Card><CardHeader title="Accounts" description="IT uses these when they leave, so add them if you can." /><CardBody className="grid gap-4 sm:grid-cols-2">
          <Input name="companyEmail" label="Company email" optional type="email" maxLength={254} width="full" defaultValue={existing.companyEmail ?? ''} />
          <Input name="ringCentralNumber" label="RingCentral number" optional type="tel" maxLength={40} width="full" defaultValue={existing.ringCentralNumber ?? ''} />
          <Input name="ringCentralExtension" label="Extension" optional inputMode="numeric" pattern="[0-9]{1,6}" maxLength={6} width="full" defaultValue={existing.ringCentralExtension ?? ''} hint="Digits only." /><span className="max-sm:hidden" />
          <Input name="datEmail" label="DAT sign-in email" optional type="email" maxLength={254} width="full" defaultValue={existing.datEmail ?? ''} hint="The email only. Never a password." />
          <Input name="truckstopEmail" label="Truckstop sign-in email" optional type="email" maxLength={254} width="full" defaultValue={existing.truckstopEmail ?? ''} hint="The email only. Never a password." />
        </CardBody></Card>
        <Card><CardHeader title="Contact" description="The catch-up link is checked against the personal email." /><CardBody className="grid gap-4 sm:grid-cols-2">
          <Input name="personalEmail" label="Personal email" optional type="email" maxLength={254} width="full" defaultValue={existing.personalEmail ?? ''} />
          <Input name="personalPhone" label="Personal phone" optional type="tel" maxLength={40} width="full" defaultValue={existing.personalPhone ?? ''} />
          {!member.details?.telegram && <Input name="telegram" label="Telegram" optional maxLength={100} width="full" autoComplete="off" defaultValue={existing.telegram ? `@${existing.telegram}` : ''} />}
        </CardBody></Card>
        <Card><CardHeader title="Signed on paper" description="A signed copy is on file with the company." /><CardBody className="grid gap-4 sm:grid-cols-2">
          <Input name="ndaSignedOn" label="NDA signed on paper" optional type="date" width="full" defaultValue={paperOn('NDA')} />
          <Input name="sopSignedOn" label="SOP signed on paper" optional type="date" width="full" defaultValue={paperOn('SOP')} />
        </CardBody></Card>
      </fieldset><Notice message={error} error /><PendingHint pending={busy} /></form>
    </Dialog>}
  </Card>;
}
