'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Send } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checkbox, RadioGroup, Select, Textarea } from '@/components/ui/field';
import { PendingHint } from '@/components/ui/pending-hint';
import { useLeaveGuard } from '@/components/shell-context';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { RULES, TelegramPreview, type AnnouncementDetail, type AnnouncementOptions } from './shared';

type Mode = 'all' | 'mc' | 'some';
/**
 * New announcement (AnnounceComposeScreen, AnnounceMcScreen, AnnounceLeadScreen, AnnounceLeadPhoneScreen). Managers choose
 * every team with a group, one MC's teams or some teams; a team lead writes to the teams they lead. The preview shows what
 * each group gets; sending goes at once.
 */
export function ComposeAnnouncement({ options, base, author, lead, presetTeam }: { options: AnnouncementOptions; base: string; author: string; lead: boolean; presetTeam: string | null }) {
  const router = useRouter();
  const linked = useMemo(() => options.teams.filter(team => team.linked), [options.teams]);
  const mcs = useMemo(() => [...new Map(linked.map(team => [team.mcId, team.mc])).entries()].map(([value, label]) => ({ value, label })), [linked]);
  const [mode, setMode] = useState<Mode>('some');
  const [mcId, setMcId] = useState(mcs[0]?.value ?? '');
  const [picked, setPicked] = useState<string[]>(() => presetTeam && linked.some(team => team.id === presetTeam) ? [presetTeam] : lead && linked.length === 1 ? [linked[0].id] : []);
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const chosen = mode === 'all' ? linked.map(team => team.id) : mode === 'mc' ? linked.filter(team => team.mcId === mcId).map(team => team.id) : picked;
  const chosenTeams = linked.filter(team => chosen.includes(team.id));
  const trimmed = text.trim(), tooLong = trimmed.length > options.maxLength;
  useLeaveGuard(trimmed && !busy ? () => window.confirm('Leave without sending this announcement?') : null);

  async function send() {
    setError('');
    if (!chosen.length) return setError('Choose at least one team.');
    if (!trimmed) return setError('Write the announcement.');
    if (tooLong) return setError(`An announcement is up to ${options.maxLength.toLocaleString('en-US')} characters.`);
    setBusy(true);
    try {
      const sent = await mutate<AnnouncementDetail>('announcements', 'POST', { teamIds: chosen, text: trimmed });
      setText(''); router.push(`${base}/${sent.id}`); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'The announcement wasn’t sent. Try again.')); setBusy(false); }
  }
  const unlinked = options.teams.filter(team => !team.linked);
  const groups = chosen.length === 1 ? '1 group' : `${chosen.length} groups`;
  const sendLabel = lead && linked.length === 1 ? `Send to ${linked[0].name}` : `Send to ${groups}`;
  const preview = <div className="grid gap-2"><p className="text-[13px] text-muted-foreground">What each group gets</p>
    <TelegramPreview chat={chosenTeams[0]?.groupTitle ?? chosenTeams[0]?.name ?? linked[0]?.groupTitle ?? 'Team group'} from={author} text={trimmed} />
    {!lead && <p className="text-[13px] text-muted-foreground">No button: there’s nothing to open. Most of the team has no workspace sign-in.</p>}</div>;

  if (!options.available) return <div className="space-y-6"><PageHeader title="New announcement" />
    <Alert tone="warning" title="Telegram isn’t set up for this workspace"><p>Announcements can be sent once the bot is set up on the server.</p></Alert></div>;
  if (!linked.length) return <div className="space-y-6"><PageHeader title="New announcement" />
    <Alert tone="info" title={lead ? 'Your team has no Telegram group yet' : 'No team has a Telegram group yet'}>
      <p>{lead ? 'Ask a dispatch manager to have an administrator link your team’s group.' : 'An administrator links teams’ groups on Admin › Telegram.'}</p></Alert></div>;

  return <div className="space-y-6">
    <PageHeader title="New announcement" description={lead && linked.length === 1 ? `To ${linked[0].name}’s Telegram group.` : 'Sent at once to each chosen team’s Telegram group by the workspace bot.'} />
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-6">
        {!(lead && linked.length === 1) && <Card><CardHeader title="To" /><CardBody className="grid gap-4">
          {!lead && <RadioGroup name="which" label="Which teams" value={mode} onChange={value => setMode(value as Mode)} options={[
            { value: 'all', label: `Every team with a group (${linked.length})` }, { value: 'mc', label: 'The teams of one MC' }, { value: 'some', label: 'Choose teams' }]} />}
          {mode === 'mc' && <Select label="MC" width="full" value={mcId} onChange={event => setMcId(event.target.value)} options={mcs} />}
          {mode === 'some' && <fieldset className="grid gap-2"><legend className="sr-only">Teams</legend>
            {options.teams.map(team => <Checkbox key={team.id} label={team.name} disabled={!team.linked} checked={picked.includes(team.id)}
              description={team.linked ? team.mc : `${team.mc} · No Telegram group linked`}
              onChange={event => setPicked(current => event.target.checked ? [...current, team.id] : current.filter(id => id !== team.id))} />)}</fieldset>}
          <p className="text-[13px] text-muted-foreground">
            {mode === 'mc' ? `Goes to ${chosenTeams.map(team => team.name).join(' and ') || 'no team'} (${groups}).` : `${chosen.length === 1 ? '1 team' : `${chosen.length} teams`} chosen.`}
            {unlinked.length > 0 && ` ${unlinked.length === 1 ? `${unlinked[0].name} has` : `${unlinked.length} teams have`} no group yet; an administrator links one on Admin › Telegram.`}</p>
        </CardBody></Card>}
        <Card><CardHeader title="Message" /><CardBody className="grid gap-3">
          <Textarea label="Write the announcement" rows={6} value={text} onChange={event => setText(event.target.value)} hint={`Plain text. Up to ${options.maxLength.toLocaleString('en-US')} characters.`} error={tooLong ? `That’s ${trimmed.length.toLocaleString('en-US')} characters; shorten it to ${options.maxLength.toLocaleString('en-US')}.` : undefined} />
          <div className="flex justify-between gap-3 text-[13px] text-muted-foreground"><span>Sent as you, with your name and role.</span><span aria-live="polite">{trimmed.length.toLocaleString('en-US')} of {options.maxLength.toLocaleString('en-US')}</span></div>
          <Alert tone="info" title="What an announcement may say"><p>{RULES}</p></Alert>
        </CardBody></Card>
        <Notice message={error} error />
        <div className="flex flex-wrap items-center justify-between gap-3 max-sm:flex-col-reverse max-sm:items-stretch">
          <Link href={base} className={buttonVariants({ variant: 'outline' })}>Cancel</Link>
          <Button onClick={() => void send()} disabled={busy}><Send aria-hidden="true" className="size-4" />{busy ? 'Sending…' : sendLabel}</Button>
        </div>
        <PendingHint pending={busy} />
      </div>
      <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">{preview}</div>
    </div>
  </div>;
}
