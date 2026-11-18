'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Ellipsis, Plus, Send, Unlink } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
import { Select } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PendingHint } from '@/components/ui/pending-hint';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';

/**
 * Admin › Telegram (section 34: TelegramGroupsScreen, TelegramLinkGroupScreen; approved 2026-11-16). Administrators link a
 * department's or a team's group with a one-time code typed in the group, and choose where each alert goes.
 */
type Purpose = 'IT' | 'SAFETY' | 'DISPATCH_MANAGERS' | 'TEAM';
type SendTo = 'PEOPLE' | 'GROUP' | 'BOTH';
export interface TelegramGroup { id: string; title: string | null; purpose: Purpose; teamId: string | null; team: string | null; linkedAt: string; linkedBy: string; lastMessageAt: string | null; lostAt: string | null }
export interface AlertRoute { alert: string; label: string; people: string | null; group: string; choices: SendTo[]; sendTo: SendTo; groupLinked: boolean }
export interface TelegramData { available: boolean; botUsername: string | null; groups: TelegramGroup[]; routes: AlertRoute[]; teams: { id: string; name: string }[] }
const PURPOSES: { value: Purpose; label: string }[] = [{ value: 'IT', label: 'IT' }, { value: 'SAFETY', label: 'Safety' }, { value: 'DISPATCH_MANAGERS', label: 'Dispatch managers' }, { value: 'TEAM', label: 'A team' }];
const SEND_LABELS: Record<SendTo, string> = { PEOPLE: 'People only', GROUP: 'Group only', BOTH: 'Group and people' };
const forLabel = (group: TelegramGroup) => group.purpose === 'TEAM' ? `Team: ${group.team ?? 'archived team'}` : PURPOSES.find(item => item.value === group.purpose)!.label;

export function TelegramGroups({ data }: { data: TelegramData }) {
  const router = useRouter(), toast = useToast();
  const [linking, setLinking] = useState(false), [unlinking, setUnlinking] = useState<TelegramGroup | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState('');
  async function act(key: string, work: () => Promise<unknown>, done: string) {
    setBusy(key); setError('');
    try { await work(); toast({ title: done }); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to save. Try again.')); }
    finally { setBusy(''); }
  }
  return <div className="space-y-6">
    <PageHeader title="Telegram" description="Alerts to Telegram groups and to staff who connected their own Telegram." action={<Button disabled={!data.available} onClick={() => setLinking(true)}><Plus aria-hidden="true" className="size-4" />Link a group</Button>} />
    {!data.available && <Alert tone="warning" title="Telegram isn’t set up for this workspace"><p>Groups can be linked once the bot is set up on the server.</p></Alert>}
    <Alert tone="info" title="What a group gets"><p>Alerts: what’s waiting and a link to the workspace, where permissions are checked. Never names of the people involved, phone numbers, emails, documents or test results. A team’s group also gets the announcements dispatch managers and its team lead write (Dispatch › Announcements).</p></Alert>
    <Notice message={error} error />
    <Card><CardHeader title="Linked groups" />
      {data.groups.length ? <Table className="mt-3 border-t border-border" caption="Telegram groups" rows={data.groups} rowKey={row => row.id} columns={[
        { key: 'group', label: 'Group', primary: true, cell: row => <div className="min-w-0"><p className="font-medium">{row.title ?? 'Telegram group'}</p><p className="text-[13px] text-muted-foreground">{row.lostAt ? 'The bot can’t post here any more' : row.lastMessageAt ? <>Last message <LocalTime iso={row.lastMessageAt} /></> : 'No messages yet'}</p></div> },
        { key: 'for', label: 'For', cell: row => <>{forLabel(row)}{row.lostAt && <span className="ml-2"><Badge label="Bot removed" tone="warning" /></span>}</> },
        { key: 'linked', label: 'Linked', nowrap: true, cell: row => <><LocalTime iso={row.linkedAt} format="date" /> by {row.linkedBy}</> },
        { key: 'actions', label: 'Actions', srOnly: true, align: 'right', action: true, cell: row => <DropdownMenu label={`Actions for ${row.title ?? 'this group'}`} triggerIcon={Ellipsis} triggerVariant="ghost" align="end" items={[
          { label: 'Send a test message', icon: Send, disabled: !!busy, onSelect: () => void act(`test-${row.id}`, () => mutate(`telegram/groups/${row.id}/test`, 'POST'), 'Test message sent') },
          { separator: true }, { label: 'Unlink', icon: Unlink, danger: true, onSelect: () => setUnlinking(row) }]} /> }]} />
        : <p className="mt-3 border-t border-border px-4 py-4 text-sm text-muted-foreground sm:px-5">No groups yet. Link one to send alerts there.</p>}
    </Card>
    <Card><CardHeader title="Where each alert goes" description="People get alerts in their own Telegram once they connect it in Account security. A group gets them once it’s linked; until then, a group-only alert goes to people." />
      <Table className="mt-3 border-t border-border" caption="Alert routing" rows={data.routes} rowKey={row => row.alert} columns={[
        { key: 'alert', label: 'Alert', primary: true, cell: row => row.label },
        { key: 'people', label: 'People', cell: row => row.people ?? '—' },
        { key: 'group', label: 'Group', cell: row => <>{row.group}{!row.groupLinked && row.sendTo !== 'PEOPLE' && <span className="block text-[13px] text-muted-foreground">Not linked yet</span>}</> },
        { key: 'send', label: 'Send to', cell: row => <Select label={<span className="sr-only">Send to, for {row.label}</span>} value={row.sendTo} width="sm" disabled={row.choices.length < 2 || !!busy}
          onChange={event => void act(`route-${row.alert}`, () => mutate(`telegram/routes/${row.alert}`, 'PATCH', { sendTo: event.target.value }), 'Saved')}
          options={row.choices.map(value => ({ value, label: SEND_LABELS[value] }))} /> }]} />
    </Card>
    {linking && <LinkGroupDialog data={data} onClose={() => setLinking(false)} />}
    {unlinking && <Dialog open tone="danger" onClose={() => setUnlinking(null)} busy={!!busy} title={`Unlink ${unlinking.title ?? 'this group'}?`} description="The group stops getting alerts. The bot stays in it until someone removes it in Telegram."
      actions={<Button variant="destructive" disabled={!!busy} onClick={() => void act('unlink', () => mutate(`telegram/groups/${unlinking.id}/unlink`, 'POST'), 'Group unlinked').then(() => setUnlinking(null))}>Unlink</Button>}><PendingHint pending={!!busy} /></Dialog>}
  </div>;
}

/** Link a group (TelegramLinkGroupScreen): choose what it's for, then type the code in the group; this checks until the bot reads it. */
function LinkGroupDialog({ data, onClose }: { data: TelegramData; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [purpose, setPurpose] = useState<Purpose>('IT'), [teamId, setTeamId] = useState(''), [code, setCode] = useState<{ id: string; command: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [expired, setExpired] = useState(false);
  const replaces = purpose !== 'TEAM' ? data.groups.find(group => group.purpose === purpose) : data.groups.find(group => group.teamId === teamId);
  async function start() {
    setBusy(true); setError(''); setExpired(false);
    try { setCode(await mutate<{ id: string; command: string; expiresAt: string }>('telegram/groups/codes', 'POST', { purpose, ...(purpose === 'TEAM' ? { teamId } : {}) })); }
    catch (failure) { setError(errorMessage(failure, 'Unable to make a code. Try again.')); }
    finally { setBusy(false); }
  }
  // Every few seconds while the dialog is open: the bot's messages are read, and the code shows whether it linked a group.
  useEffect(() => {
    if (!code || expired) return;
    let stopped = false;
    const timer = setInterval(() => void mutate<{ linked: { title: string | null } | null; expired: boolean }>(`telegram/groups/codes/${code.id}/check`, 'POST').then(result => {
      if (stopped) return;
      if (result.linked) { stopped = true; clearInterval(timer); toast({ title: `${result.linked.title ?? 'The group'} is linked` }); onClose(); router.refresh(); }
      else if (result.expired) { stopped = true; clearInterval(timer); setExpired(true); }
    }).catch(() => undefined), 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [code, expired, onClose, router, toast]);
  return <Dialog open onClose={onClose} busy={busy} title="Link a Telegram group" description="The bot posts in the group only what this page sends there."
    actions={code && !expired ? <Button variant="outline" onClick={onClose}>Close</Button> : <Button disabled={busy || (purpose === 'TEAM' && !teamId)} onClick={() => void start()}>{busy ? 'Getting a code…' : expired ? 'Get a new code' : 'Get a code'}</Button>}>
    <div className="space-y-4">
      <Select label="This group is for" value={purpose} disabled={!!code && !expired} width="full" onChange={event => { setPurpose(event.target.value as Purpose); setCode(null); }} options={PURPOSES} />
      {purpose === 'TEAM' && <Select label="Team" value={teamId} placeholder="Choose a team" disabled={!!code && !expired} width="full" onChange={event => { setTeamId(event.target.value); setCode(null); }} options={data.teams.map(team => ({ value: team.id, label: team.name }))} />}
      {replaces && !code && <Alert tone="info"><p>{replaces.title ?? 'A group'} is linked for this now. The new group takes its place.</p></Alert>}
      {code && !expired && <><ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>In Telegram, add <strong>@{data.botUsername}</strong> to the group.</li>
        <li>Send this message in the group:<div className="mt-1 font-mono text-[22px] font-semibold tracking-[4px]">{code.command}</div></li>
        <li>This page shows the group once the bot reads it.</li></ol>
        <Alert tone="info" title="Waiting for the code in a group"><p>The code works once and for 10 minutes. A code sent in a private chat with the bot doesn’t link anything.</p></Alert>
        <PendingHint pending /></>}
      {expired && <Alert tone="warning" title="The code expired"><p>Get a new code and send it in the group within 10 minutes.</p></Alert>}
      <Notice message={error} error />
    </div>
  </Dialog>;
}
