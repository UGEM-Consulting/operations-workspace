'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Archive, ArchiveRestore, Ellipsis, PenLine, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { initials } from '@/components/ui/avatar';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { PrivateImage } from '@/components/ui/private-image';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { PageCrumb } from '@/components/shell-context';
import { errorMessage, mutate } from '@/lib/client-api';
import { middayIso } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { TeamEditor } from './team-editor';
import { type Choice, supportName, type TeamDetail, type TeamPerson } from './types';

type Dispatcher = TeamDetail['dispatchers'][number];
type Helper = TeamDetail['helpers'][number];
const name = (person: TeamPerson) => `${person.firstName} ${person.lastName}`;
const chunk = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));

/**
 * A team's page (designed in the Design System as an org chart and approved 2026-11-05): the lead on top, who assists
 * them on the left and the whole team on the right, a line down to every dispatcher (four to a row, two on narrower
 * screens) with their supports and updaters under them. Below 1024px it's a list joined by one line. Every card opens
 * that person's dispatcher page.
 */
export function TeamPage({ team, mcs }: { team: TeamDetail; mcs: Choice[] }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const lead = team.dispatchers.find(person => person.id === team.leadId) ?? null;
  const others = team.dispatchers.filter(person => person.id !== team.leadId);
  const helpersOf = (id: string) => team.helpers.filter(helper => helper.dispatcherId === id);
  const wholeTeam = team.helpers.filter(helper => helper.teamId === team.id);
  const occupied = team.dispatchers.length + wholeTeam.length > 0;
  // Only the team's own active dispatchers can lead it, and not someone who is leaving (unless they already do).
  const candidates = team.dispatchers.filter(person => person.status === 'ACTIVE' && (!person.lastDay || person.id === team.leadId))
    .map(person => ({ id: person.id, name: name(person), companyEmail: person.companyEmail, accountStatus: person.accountStatus }));
  async function archive() {
    if (pending) return;
    setPending(true);
    try {
      await mutate(`dispatch/teams/${team.id}`, 'PATCH', { version: team.version, archived: !team.archived });
      toast({ title: team.archived ? `${team.name} restored` : `${team.name} archived` });
      router.refresh();
    } catch (error) { toast({ tone: 'danger', title: 'Not changed', description: errorMessage(error, 'Reload the page and try again.') }); }
    finally { setPending(false); }
  }
  const leadSlot = lead ? <Card person={lead} kind="lead" /> : <div className="grid justify-items-center gap-2 rounded-lg border border-dashed border-[var(--border-strong)] bg-card p-4 text-center">
    <p className="text-[15px] font-semibold">No team lead yet</p><p className="text-[13px] text-muted-foreground">Choose one of the team’s active dispatchers.</p>
    {!team.archived && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><UserPlus aria-hidden="true" className="size-4" />Choose team lead</Button>}
  </div>;
  const leadHelpers = lead ? helpersOf(lead.id) : [];
  const side = (label: string, people: Helper[], end: boolean) => people.length ? <div className={cn('org-side relative grid w-[236px] gap-2', end ? 'org-side-end ml-8 justify-self-start' : 'org-side-start mr-8 justify-self-end')}>
    <p className="text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">{label}</p>{people.map(person => <Card key={person.id} person={person} kind="sm" />)}
  </div> : <div />;
  const rows = (size: number, className: string) => <div className={cn('w-full justify-items-center gap-6', className)} role="list" aria-label="Dispatchers">
    {chunk(others, size).map((row, index) => <div key={index} className="org-row" style={{ '--cols': row.length } as React.CSSProperties}>
      {row.map(person => <div key={person.id} role="listitem" className="org-branch"><Card person={person} /><Helpers people={helpersOf(person.id)} /></div>)}
    </div>)}
  </div>;
  return <div className="space-y-6">
    <PageCrumb label={team.name} />
    <PageHeader title={team.name} badge={team.archived ? <Badge label="Archived" tone="neutral" /> : undefined}
      meta={[team.mc.name, `${team.dispatchers.length} dispatcher${team.dispatchers.length === 1 ? '' : 's'}`, ...(team.helpers.length ? [team.helpers.length === 1 ? `1 ${supportName(team.helpers[0]).toLowerCase()}` : `${team.helpers.length} supports and updaters`] : [])]}
      action={<div className="flex gap-2">
        {!team.archived && <Button onClick={() => setEditing(true)}><PenLine aria-hidden="true" className="size-4" />Edit team</Button>}
        <DropdownMenu label="More actions" triggerIcon={Ellipsis} align="end" items={[team.archived
          ? { label: pending ? 'Restoring…' : 'Restore team', icon: ArchiveRestore, onSelect: () => void archive(), disabled: pending }
          // A team can only be archived once nobody works in it or assists it; the API says the same.
          : { label: occupied ? 'Archive team (move everyone first)' : 'Archive team', icon: Archive, danger: true, onSelect: () => void archive(), disabled: pending || occupied }]} />
      </div>} />
    {/* The chart from 1024px. */}
    <div className="hidden justify-items-center pt-2 lg:grid">
      <div className="grid w-full grid-cols-[minmax(0,1fr)_300px_minmax(0,1fr)] items-center">
        {side(`Assists ${lead?.firstName ?? 'the lead'}`, leadHelpers, false)}<div>{leadSlot}</div>{side('Assists the whole team', wholeTeam, true)}
      </div>
      {others.length > 0 && <>
        <div aria-hidden="true" className="h-8 w-0.5 bg-[var(--border-strong)]" />
        {rows(4, 'hidden xl:grid')}{rows(2, 'grid xl:hidden')}
      </>}
    </div>
    {/* A list below 1024px: the lead, who assists them and the whole team, then the dispatchers joined by one line. */}
    <div className="grid gap-4 lg:hidden">
      {leadSlot}
      {leadHelpers.length > 0 && <Section label={`Assists ${lead!.firstName}`}>{leadHelpers.map(person => <Card key={person.id} person={person} kind="sm" />)}</Section>}
      {wholeTeam.length > 0 && <Section label="Assists the whole team">{wholeTeam.map(person => <Card key={person.id} person={person} kind="sm" />)}</Section>}
      {others.length > 0 && <Section label="Dispatchers"><div role="list" aria-label="Dispatchers" className="ml-6 grid gap-3 border-l-2 border-[var(--border-strong)] pl-4">
        {others.map(person => <div key={person.id} role="listitem" className="grid gap-2"><Card person={person} /><Helpers people={helpersOf(person.id)} /></div>)}
      </div></Section>}
    </div>
    {!team.dispatchers.length && <EmptyState compact title="No dispatchers in this team yet" description="Move a dispatcher here from their page: More actions › Move to another MC or team." />}
    {editing && <TeamEditor team={{ id: team.id, name: team.name, version: team.version, mcId: team.mc.id, leadId: team.leadId, occupied }} mcs={mcs} candidates={candidates} onClose={() => setEditing(false)} />}
  </div>;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className="grid gap-2"><h2 className="text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">{label}</h2>{children}</section>;
}
function Helpers({ people }: { people: Helper[] }) {
  return people.length ? <div className="ml-6 grid gap-2 border-l-2 border-border pl-3">{people.map(person => <Card key={person.id} person={person} kind="sm" />)}</div> : null;
}

/** One person: their profile photo (or initials), name, what they do and any badge. The whole card opens their page. */
function Card({ person, kind }: { person: Dispatcher | Helper; kind?: 'lead' | 'sm' }) {
  const full = name(person);
  const dispatcher = 'drivers' in person ? person : null;
  const role = dispatcher ? `${dispatcher.jobTitle ?? 'Dispatcher'} · ${dispatcher.drivers ? `${dispatcher.drivers} driver${dispatcher.drivers === 1 ? '' : 's'}` : 'no drivers yet'}` : supportName(person);
  const photo = kind === 'lead' ? 'size-[72px] text-[22px]' : kind === 'sm' ? 'size-9 text-[13px]' : 'size-14 text-lg';
  return <Link href={`/dispatch/dispatchers/${person.id}`} aria-label={`${full}, ${kind === 'lead' ? 'team lead, ' : ''}${role}`}
    className={cn('flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card text-foreground no-underline transition-colors hover:border-[var(--border-strong)] focus-visible:outline-2 focus-visible:outline-offset-2',
      kind === 'lead' ? 'border-[var(--border-strong)] p-4 shadow-xs' : kind === 'sm' ? 'px-3 py-2' : 'p-3 shadow-xs')}>
    {person.photo ? <PrivateImage src={`/api/backend/dispatch/members/${person.id}/photos/selfie`} alt="" className={cn('shrink-0 rounded-full bg-muted object-cover', photo)} />
      : <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-full bg-muted font-semibold text-muted-foreground', photo)}>{initials(full)}</span>}
    <span className="min-w-0 flex-1">
      <span className={cn('block truncate', kind === 'sm' ? 'text-sm font-medium' : 'text-[15px] font-semibold leading-[22px]')}>{full}</span>
      <span className="block text-[13px] leading-5 text-muted-foreground">{role}</span>
      {(kind === 'lead' || person.status === 'ONBOARDING' || person.lastDay) && <span className="mt-1.5 flex flex-wrap gap-1.5">
        {kind === 'lead' && <Badge label="Team lead" tone="info" />}
        {person.status === 'ONBOARDING' && <Badge label="In IT setup" tone="neutral" />}
        {person.lastDay && <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-warning-background px-2.5 py-0.5 text-xs font-medium leading-5 text-warning"><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />Leaving <LocalTime iso={middayIso(person.lastDay)} format="date" /></span>}
      </span>}
    </span>
  </Link>;
}
