'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { fullName, type Choice, type MemberProfile, type TeamRow } from './types';

/**
 * A dispatch manager or administrator promotes a support or updater from their page (section 44: PromoteDialogScreen,
 * PromoteRefusedScreen). The same choices as deciding a team lead's request, starting at their dispatcher's MC and team; it's
 * recorded as a promotion asked and approved at once, and IT setup starts as it does then. Someone added by hand whose paperwork
 * isn't accepted can't be promoted yet, and the dialog says what to do first.
 */
export function PromoteDialog({ member, mcs, teams, jobTitles, onClose }: { member: MemberProfile; mcs: Choice[]; teams: TeamRow[]; jobTitles: Choice[]; onClose: () => void }) {
  const router = useRouter(), toast = useToast(), name = fullName(member), first = member.firstName;
  const helped = member.supportOf ?? null, helping = helped?.wholeTeam ?? helped?.dispatcher ?? null;
  const activeMcs = mcs.filter(mc => !mc.archived), startMc = activeMcs.find(mc => mc.name === helped?.mc)?.id ?? '';
  const [mcId, setMcId] = useState(startMc), [teamId, setTeamId] = useState(() => teams.find(team => !team.archived && team.mc.id === startMc && team.name === helped?.team)?.id ?? '');
  const [titleId, setTitleId] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const teamChoices = teams.filter(team => !team.archived && team.mc.id === mcId);
  if (!member.applicationId) return <Dialog open onClose={onClose} title={`Promote ${name} to dispatcher`} closeLabel="Close">
    <Alert tone="warning" title="Their paperwork isn’t accepted yet"><p>{first} was added by hand. IT setup starts from their application, so accept their paperwork first: Create catch-up link, then Accept paperwork when they send it.</p></Alert>
  </Dialog>;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    if (!titleId || !mcId) { setError(!titleId ? 'Choose their job title.' : 'Choose the MC they will dispatch for.'); return; }
    setBusy(true); setError('');
    try {
      await mutate(`dispatch/promotions/members/${member.id}`, 'POST', { version: member.version, mcId, teamId: teamId || null, jobTitleId: titleId, ...(note.trim() ? { note: note.trim() } : {}) });
      toast({ title: `${name} promoted to dispatcher`, description: 'IT got a dispatcher setup checklist. They’re Active once IT finishes.' }); onClose(); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to promote them. Your choices have been kept.')); }
    finally { setBusy(false); }
  }
  return <Dialog open onClose={onClose} busy={busy} size="lg" title={`Promote ${name} to dispatcher`} description={`${first} becomes a dispatcher in Onboarding today. Their documents and photos carry over: there’s no new application.`}
    actions={<Button type="submit" form="promote-support" disabled={busy}><TrendingUp aria-hidden="true" className="size-4" />{busy ? 'Promoting…' : 'Promote'}</Button>}>
    <form id="promote-support" onSubmit={submit} className="space-y-4"><fieldset disabled={busy} className="min-w-0 space-y-4">
      <Select label="Job title" value={titleId} onChange={event => setTitleId(event.target.value)} required placeholder="Choose a job title" width="full"
        options={jobTitles.filter(title => !title.archived).map(title => ({ value: title.id, label: title.name }))} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="MC" value={mcId} onChange={event => { setMcId(event.target.value); setTeamId(''); }} required placeholder="Choose an MC" width="full" hint={helping && startMc ? `Starts at ${helping}’s.` : undefined}
          options={activeMcs.map(mc => ({ value: mc.id, label: mc.name }))} />
        <Select label="Team" value={teamId} onChange={event => setTeamId(event.target.value)} width="full" options={[{ value: '', label: 'Independent (no team)' }, ...teamChoices.map(team => ({ value: team.id, label: team.name }))]} />
      </div>
      <Textarea label="Note" optional rows={2} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} hint="Kept with the promotion. Staff only: never health, family or other private details." />
      <Alert tone="info" title="What happens"><ul className="list-disc space-y-1 pl-5 text-sm">
        {helping && <li>{first} stops helping {helping}.{helped?.wholeTeam ? '' : ` ${helping} keeps their drivers.`}</li>}
        <li>IT gets a dispatcher setup checklist and an alert, filled with the accounts IT already set up for {first}.</li>
        <li>{first} is Active once IT finishes. Nobody is messaged.</li></ul></Alert>
      {error && <Alert tone="danger"><p>{error}</p></Alert>}
    </fieldset></form>
  </Dialog>;
}
