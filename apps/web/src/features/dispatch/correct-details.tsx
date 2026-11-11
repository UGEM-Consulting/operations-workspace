'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Input, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { fullName, type MemberCorrection, type MemberProfile } from './types';

/**
 * Correcting details (section 36, designed as CorrectDetailsScreen, CorrectedProfileScreen, CorrectionHistoryScreen and
 * CorrectNameByHandScreen, approved 2026-11-11). Administrators only. The application keeps what was sent and signed
 * documents keep the name they were signed with; the workspace shows the corrected details everywhere else.
 */
const FIELDS = [['legalFirstName', 'Legal first name'], ['legalLastName', 'Legal last name'], ['preferredAmericanFirstName', 'American first name'], ['preferredAmericanLastName', 'American last name'],
 ['personalEmail', 'Personal email'], ['personalPhoneNumber', 'Personal phone'], ['telegram', 'Telegram']] as const;
export const correctionLabels: Record<string, string> = { ...Object.fromEntries(FIELDS), firstName: 'First name', lastName: 'Last name' };
type Field = typeof FIELDS[number][0];

/** What the application said for a field that was corrected: the earliest correction's earlier value. */
function original(corrections: MemberCorrection[], field: string) {
 for (let index = corrections.length - 1; index >= 0; index -= 1) { const change = corrections[index].changes.find(item => item.field === field); if (change) return change.from; }
 return undefined;
}
/** "Corrected by Morgan Ellis on Nov 11, 2026", under a value that was corrected. */
export function Corrected({ member, field }: { member: MemberProfile; field: string }) {
 const corrected = member.correctedFields?.[field];
 return corrected ? <span className="block text-[13px] text-muted-foreground">Corrected by {corrected.by} on <LocalTime iso={corrected.at} format="date"/></span> : null;
}

export function CorrectDetailsDialog({ member, onClose }: { member: MemberProfile; onClose: () => void }) {
 const router = useRouter(), toast = useToast(), name = fullName(member);
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 const details = member.details ?? null, corrections = member.corrections ?? [];
 const current: Record<string, string> = details ? Object.fromEntries(FIELDS.map(([field]) => [field, details[field as Field] ?? ''])) : { firstName: member.firstName, lastName: member.lastName };
 const hint = (field: string) => { const before = original(corrections, field); return before === undefined ? (details ? 'From their application.' : undefined) : `Application: ${before ?? 'empty'}`; };
 async function submit(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (busy) return;
  const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
  // Only what changed goes to the API.
  const changed = Object.fromEntries(Object.keys(current).filter(field => (form[field] ?? '').trim() !== current[field]).map(field => [field, form[field].trim()]));
  if (!Object.keys(changed).length) { setError('Nothing changed.'); return; }
  setBusy(true); setError('');
  try { await mutate(`dispatch/members/${member.id}/correct`, 'POST', { version: member.version, reason: form.reason, ...changed }); toast({ title: 'Details corrected' }); onClose(); router.refresh(); }
  catch (failure) { setError(errorMessage(failure, 'Unable to save. Your entries have been kept.')); }
  finally { setBusy(false); }
 }
 const input = (field: string, label: string, props: Partial<React.ComponentProps<typeof Input>> = {}) => <Input key={field} label={label} name={field} defaultValue={current[field]} hint={hint(field)} width="full" maxLength={field === 'personalEmail' ? 254 : field === 'personalPhoneNumber' ? 40 : 100} autoComplete="off" {...props}/>;
 return <Dialog open onClose={onClose} busy={busy} size="lg" title={details ? `Correct ${name}’s details` : `Correct ${name}’s name`} description="Change only what is wrong. Nobody is messaged."
  actions={<Button type="submit" form="correct-details">{busy ? 'Saving…' : 'Save corrections'}</Button>}>
  <form id="correct-details" onSubmit={submit} className="space-y-4">
   {details ? <>
    <Card><CardHeader title="Names"/><CardBody className="space-y-4">
     <div className="grid gap-4 sm:grid-cols-2">{input('legalFirstName', 'Legal first name', { required: true })}{input('legalLastName', 'Legal last name', { required: true })}</div>
     <div className="grid gap-4 sm:grid-cols-2">{input('preferredAmericanFirstName', 'American first name', { required: true, pattern: "[A-Za-z][A-Za-z .,'\\-]*" })}{input('preferredAmericanLastName', 'American last name', { required: true, pattern: "[A-Za-z][A-Za-z .,'\\-]*" })}</div>
    </CardBody></Card>
    <Card><CardHeader title="Contact"/><CardBody className="space-y-4">
     <div className="grid gap-4 sm:grid-cols-2">{input('personalEmail', 'Personal email', { type: 'email', required: true })}{input('personalPhoneNumber', 'Personal phone', { type: 'tel', required: true })}</div>
     <div className="grid gap-4 sm:grid-cols-2">{input('telegram', 'Telegram', { optional: true })}<div/></div>
    </CardBody></Card>
   </> : <div className="grid gap-4 sm:grid-cols-2">{input('firstName', 'First name', { required: true })}{input('lastName', 'Last name', { required: true })}</div>}
   <Textarea label={details ? 'Why' : 'Why the name changed'} name="reason" required maxLength={500} rows={2} hint="Kept in their history. Never health or other private details."/>
   {details && <Alert tone="info" title="What changes"><p>The workspace shows the corrected details everywhere, including IT’s pages and a removal if they leave. Their application keeps what they sent, and signed documents keep the name they were signed with.</p></Alert>}
   <Notice message={error} error/>
  </form>
 </Dialog>;
}

/** Each correction, for the History tab: the fields with their earlier and new values, why and who. Staff only. */
/** Each correction as an entry of the History timeline, with its date for sorting among the other entries. */
export function correctionItems(corrections: MemberCorrection[]) {
 return corrections.map(correction => ({ id: correction.id, at: correction.createdAt, tone: 'info' as const, title: 'Details corrected', meta: <>{correction.correctedBy} · <LocalTime iso={correction.createdAt}/></>,
  body: `${correction.changes.map(change => `${correctionLabels[change.field] ?? change.field}: ${change.from ?? 'empty'} → ${change.to ?? 'empty'}`).join('. ')}. Why: ${correction.reason}` }));
}
