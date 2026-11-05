'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import type { Choice } from './types';

/** Someone who may lead the team: one of its active dispatchers, with what their sign-in needs. */
export interface LeadCandidate { id: string; name: string; companyEmail?: string | null; accountStatus?: 'ACTIVE' | 'INACTIVE' | null }
/** The team being edited, or null to add one. `occupied` keeps its MC: it has dispatchers or people assisting it. */
export interface EditableTeam { id: string; name: string; version: number; mcId: string; leadId: string | null; occupied: boolean }

/**
 * Add team, or Edit team from its page. Choosing a lead says what happens to their sign-in (designed as TeamLeadChooseScreen
 * and TeamLeadChooseNoEmailScreen): IT creates it with their company email, or turns their old one back on. The team changes
 * straight away either way.
 */
export function TeamEditor({ team, mcs, candidates, onClose }: { team: EditableTeam | null; mcs: Choice[]; candidates: LeadCandidate[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [leadId, setLeadId] = useState(team?.leadId ?? '');
  const chosen = leadId && leadId !== team?.leadId ? candidates.find(candidate => candidate.id === leadId) : undefined;
  const first = chosen?.name.split(' ')[0];
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPending(true); setError('');
    try {
      if (team) await mutate(`dispatch/teams/${team.id}`, 'PATCH', { version: team.version, name: form.name, ...(team.occupied ? {} : { mcId: form.mcId }), leadMemberId: form.leadMemberId || null });
      else await mutate('dispatch/teams', 'POST', { name: form.name, mcId: form.mcId });
      toast({ title: team ? 'Team updated' : 'Team added', description: chosen && chosen.accountStatus !== 'ACTIVE' ? `IT will ${chosen.accountStatus ? 'turn on' : 'create'} ${first}’s sign-in.` : undefined });
      onClose(); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  const activeMcs = mcs.filter(mc => !mc.archived || mc.id === team?.mcId);
  return <Dialog open onClose={onClose} busy={pending} title={team ? `Edit ${team.name}` : 'Add team'}
    actions={<Button type="submit" form="team-editor">{pending ? 'Saving…' : team ? 'Save changes' : 'Add team'}</Button>}>
    <form id="team-editor" onSubmit={save} className="space-y-4">
      <Input label="Team name" name="name" defaultValue={team?.name} required maxLength={100} autoComplete="off" width="full" hint="Usually the team lead’s name, such as Avery team." />
      <Select label="MC" name="mcId" defaultValue={team?.mcId ?? ''} required disabled={!!team?.occupied} placeholder={team ? undefined : 'Choose an MC'} width="full"
        options={activeMcs.map(mc => ({ value: mc.id, label: mc.name }))} hint={team?.occupied ? 'A team keeps its MC while it has dispatchers or anyone assisting it.' : undefined} />
      {team && <Select label="Team lead" name="leadMemberId" value={leadId} onChange={event => setLeadId(event.target.value)} placeholder="No team lead" width="full"
        options={candidates.map(candidate => ({ value: candidate.id, label: candidate.name }))} hint={candidates.length ? 'One of this team’s dispatchers.' : 'Move a dispatcher into this team first.'} />}
      {chosen && chosen.accountStatus === 'INACTIVE' && <Alert tone="info" title={`IT will turn ${first}’s sign-in back on`}>Saving asks IT to do this, with a new first password.</Alert>}
      {chosen && !chosen.accountStatus && (chosen.companyEmail
        ? <Alert tone="info" title={`IT will create ${first}’s sign-in`}>It will use their company email, {chosen.companyEmail}. Saving asks IT to do this.</Alert>
        : <Alert tone="warning" title={`${first} has no company email recorded`}>You can still make them the lead. IT will add the email before creating their sign-in, because that’s what they sign in with.</Alert>)}
      <Notice message={error} error />
    </form>
  </Dialog>;
}
