'use client';
import Link from 'next/link';
import { phoneLabel } from '@/lib/phone';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checkbox, RadioGroup } from '@/components/ui/field';
import { mutate } from '@/lib/client-api';
import type { MemberProfile, SharedKind, SharedUse, SharedUsedBy } from './types';

// Shared company email and RingCentral number (designed as SharedRecordScreen, SharedProfileScreen, SharedOwnerPhoneScreen
// and SharedLeavingScreen, section 35, approved 2026-11-17). An email or number has one owner; others use it, shared.

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
const same = (kind: SharedKind, a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (kind === 'EMAIL' ? a.trim().toLowerCase() === b.trim().toLowerCase() : a.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') === b.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''));
const personLink = (person: { id: string; name: string }) => <Link key={person.id} href={`/dispatch/dispatchers/${person.id}`} className="text-primary underline underline-offset-2">{person.name}</Link>;
const joined = (people: { id: string; name: string }[]) => people.flatMap((person, index) => [...(index ? [index === people.length - 1 ? ' and ' : ', '] : []), personLink(person)]);

/** What they use of someone else's, of one kind. */
export const usedOf = (member: Pick<MemberProfile, 'sharing'>, kind: SharedKind) => member.sharing?.uses.find(item => item.kind === kind) ?? null;
/** Who else uses this value of theirs. */
export const usersOf = (member: Pick<MemberProfile, 'sharing'>, kind: SharedKind, value: string | null | undefined) => member.sharing?.usedBy.find(item => item.kind === kind && same(kind, item.value, value))?.users ?? [];

/** "riley.santos@… / Riley Santos’s, shared since Nov 17, 2026", or a handed-over one, which is theirs now. */
export function SharedValue({ use, mono = false }: { use: SharedUse; mono?: boolean }) {
  return <span className="grid gap-0.5"><span className={mono ? 'break-all font-mono' : 'break-all'}>{use.kind === 'RINGCENTRAL' ? phoneLabel(use.value) : use.value}</span>
    <span className="text-[13px] font-normal text-muted-foreground">{use.handedOver ? <>Handed over{use.owner ? <> from {personLink(use.owner)}</> : null} on {day(use.since)}</>
      : <>{use.owner ? <>{personLink(use.owner)}’s</> : 'Someone else’s'}, shared since {day(use.since)}</>}</span>
    {/* The owner's access is going before they're Left: say so, so nobody counts on it. */}
    {!use.handedOver && use.ownerRemoval && <span className="text-[13px] font-normal text-warning">{use.ownerRemoval.toThem ? 'Being handed over to them as IT removes the owner’s access.' : use.ownerRemoval.handOverTo ? `Being handed over to ${use.ownerRemoval.handOverTo}; the password will change.` : use.ownerRemoval.done ? 'IT has removed the owner’s access, so it may no longer work.' : 'IT is removing the owner’s access, so it may stop working.'}</span>}</span>;
}
/** Their own value, with who else uses it. */
export function OwnValue({ value, users, mono = false }: { value: string; users: { id: string; name: string }[]; mono?: boolean }) {
  // mono is a RingCentral number, shown in the one phone format.
  const shown = mono ? phoneLabel(value) : value;
  if (!users.length) return <span className={mono ? 'font-mono' : undefined}>{shown}</span>;
  return <span className="grid gap-0.5"><span className={mono ? 'break-all font-mono' : 'break-all'}>{shown}</span><span className="text-[13px] font-normal text-muted-foreground">Also used by {joined(users)}</span></span>;
}

export interface Owner { id: string; name: string; onRecord: boolean }
/** Someone who had it before they left, or whose it was until IT retired or closed it (section 44). */
export interface FormerOwner { id: string; name: string; until: string | null }
const untilDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
/**
 * An email or number typed that was someone's who left (PreviousOwnerEditScreen): whose, until when, and a tick that IT
 * confirmed it's theirs now, which saving needs. Numbers aren't reused here, so the number's wording says so.
 */
export type PreviousOwnerItem = { kind: 'EMAIL' | 'RINGCENTRAL'; former: FormerOwner };
export function PreviousOwnerWarning({ firstName, items, confirmed, onChange }: { firstName: string; items: PreviousOwnerItem[]; confirmed: boolean; onChange: (value: boolean) => void }) {
  if (!items.length) return null;
  // One tick covers every value named here, so each gets its own warning first.
  const what = items.length > 1 ? 'email and number' : items[0].kind === 'EMAIL' ? 'email' : 'number';
  return <div className="space-y-3 sm:col-span-2">
    {items.map(({ kind, former }) => {
      const word = kind === 'EMAIL' ? 'email' : 'number', first = former.name.split(' ')[0];
      return <Alert key={kind} tone="warning" title={`This ${word} was ${former.name}’s`}><p>{former.until ? `${first} had it until ${untilDay(former.until)}. ` : `${first} had it before they left. `}{kind === 'RINGCENTRAL' ? 'Numbers aren’t reused here, so check' : 'Check'} with IT before recording it for {firstName}.</p></Alert>;
    })}
    <Checkbox label={`IT confirmed this ${what} ${items.length > 1 ? 'are' : 'is'} ${firstName}’s now`} description={`Needed to save ${items.length > 1 ? 'them' : 'it'}. Recorded with who ticked it, in ${firstName}’s History.`} checked={confirmed} onChange={event => onChange(event.target.checked)} />
  </div>;
}
/**
 * Whose a company email or RingCentral number being typed is (POST, so the value never travels in a URL). Asked a moment
 * after typing stops, and only for a value that looks complete; a late answer for an earlier value is ignored.
 */
export function useAccountOwners(memberId: string | null, values: { companyEmail: string; ringCentralNumber: string }) {
  const [found, setOwners] = useState<{ key: string; companyEmail: Owner[]; ringCentralNumber: Owner[]; former: { companyEmail: FormerOwner[]; ringCentralNumber: FormerOwner[] } }>({ key: '', companyEmail: [], ringCentralNumber: [], former: { companyEmail: [], ringCentralNumber: [] } });
  const asked = useRef(0);
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.companyEmail.trim()) ? values.companyEmail.trim() : '', number = values.ringCentralNumber.replace(/\D/g, '').length >= 7 ? values.ringCentralNumber.trim() : '';
  const key = `${email}|${number}`;
  useEffect(() => {
    const ask = ++asked.current;
    if (!email && !number) return;
    const timer = setTimeout(() => {
      mutate<{ companyEmail: Owner[]; ringCentralNumber: Owner[]; formerOwners?: { companyEmail: FormerOwner[]; ringCentralNumber: FormerOwner[] } }>('dispatch/existing/account-owners', 'POST', { ...(memberId ? { memberId } : {}), ...(email ? { companyEmail: email } : {}), ...(number ? { ringCentralNumber: number } : {}) })
        // formerOwners (section 44): who had it before they left; an older API sends none.
        .then(answer => { if (ask === asked.current && answer) setOwners({ key: `${email}|${number}`, companyEmail: email ? answer.companyEmail : [], ringCentralNumber: number ? answer.ringCentralNumber : [], former: { companyEmail: email ? answer.formerOwners?.companyEmail ?? [] : [], ringCentralNumber: number ? answer.formerOwners?.ringCentralNumber ?? [] : [] } }); })
        // An older API has no such route: nothing is asked, and saving answers as before.
        .catch(() => { if (ask === asked.current) setOwners({ key: `${email}|${number}`, companyEmail: [], ringCentralNumber: [], former: { companyEmail: [], ringCentralNumber: [] } }); });
    }, 400);
    return () => clearTimeout(timer);
  }, [memberId, email, number]);
  // Only an answer for what's typed now counts.
  return found.key === key ? found : { companyEmail: [], ringCentralNumber: [], former: { companyEmail: [], ringCentralNumber: [] } };
}

/**
 * Edit recorded details: the email or number typed is someone else's (SharedRecordScreen). Asks whether this person uses it
 * too; answering No asks to fix what was typed.
 */
export function ShareQuestion({ firstName, email, number, value, onChange }: { firstName: string; email: Owner | null; number: Owner | null; value: 'yes' | 'no' | ''; onChange: (value: 'yes' | 'no') => void }) {
  if (!email && !number) return null;
  const owner = email?.name ?? number!.name, both = !!email && !!number && email.id === number.id;
  const what = both ? 'email and number' : email ? 'email' : 'number', these = both ? 'them' : 'it';
  return <div className="space-y-4 sm:col-span-2">
    <Alert tone="warning" title={both || !email || !number ? `This ${what} ${both ? 'are' : 'is'} ${owner}’s` : `This email is ${email.name}’s and this number is ${number.name}’s`}>
      <p>They’re on {both || !email || !number ? `${owner}’s` : 'their'} record. If {firstName} uses {these} too, record {these} as shared: {these} stay{both ? '' : 's'} {owner}’s, and both pages say who else uses {these}.</p></Alert>
    <RadioGroup name="shareAnswer" label={`Does ${firstName} use ${both || !email || !number ? `${owner}’s ${what}` : 'them'}?`} cards value={value} onChange={next => onChange(next as 'yes' | 'no')} options={[
      { value: 'yes', label: `Yes, ${firstName} uses ${these} too`, description: 'Recorded as shared. IT won’t close it while either of them still works here.' },
      { value: 'no', label: 'No, I typed the wrong one', description: `Change the ${what} above.` }]} />
  </div>;
}

/** Marking an owner as leaving while others use their email or number (SharedLeavingScreen): hand them over, or close them. */
export function HandOverChoice({ member, value, onChange }: { member: Pick<MemberProfile, 'firstName' | 'sharing'>; value: string; onChange: (value: string) => void }) {
  const usedBy: SharedUsedBy[] = member.sharing?.usedBy ?? [];
  if (!usedBy.length) return null;
  const users = [...new Map(usedBy.flatMap(item => item.users).map(user => [user.id, user])).values()];
  const kinds = (id: string) => usedBy.filter(item => item.users.some(user => user.id === id)).map(item => item.kind === 'EMAIL' ? 'the email' : 'the number');
  const what = usedBy.length > 1 ? 'email and number' : usedBy[0].kind === 'EMAIL' ? 'email' : 'number';
  return <Card><CardHeader title={`${member.firstName}’s ${what} ${usedBy.length > 1 ? 'are' : 'is'} also used`} description={users.map(user => `${user.name} uses ${kinds(user.id).join(' and ')}`).join('. ') + '.'} />
    <CardBody><RadioGroup name="handOverTo" label={`After ${member.firstName} leaves`} cards value={value} onChange={onChange} options={[
      ...users.map(user => ({ value: user.id, label: `Hand ${usedBy.length > 1 ? 'them' : 'it'} over to ${user.name}`, description: `${usedBy.length > 1 ? 'They become' : 'It becomes'} ${user.name}’s. IT keeps ${usedBy.length > 1 ? 'them' : 'it'} open and changes the password.${users.length > 1 ? ' The others keep using it, now ' + user.name + '’s.' : ''}` })),
      { value: '', label: `Close ${usedBy.length > 1 ? 'them' : 'it'}`, description: `IT closes ${usedBy.length > 1 ? 'them' : 'it'} as usual. ${users.length > 1 ? 'The others stop' : `${users[0].name} stops`} using ${usedBy.length > 1 ? 'them' : 'it'}, so tell them first.` }]} /></CardBody></Card>;
}
