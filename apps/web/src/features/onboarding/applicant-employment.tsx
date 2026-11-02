'use client';
import type { FocusEventHandler, ReactNode, Ref } from 'react';
import { Alert } from '@/components/ui/alert';
import { Select } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import type { ApplicantEmploymentOptions, FieldName } from './types';

const INDEPENDENT = 'Independent', NOT_LISTED = 'Not listed', NO_TEAM = 'No team yet';
const EARLIER = 'This isn’t on the list. Choose from the list if you can.';
const key = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
type Name = 'mcName' | 'teamLead' | 'jobTitle';
type Option = { value: string; label: string };

/** A new application starts on the usual job title when the list has it. */
export function startingJobTitle(options: ApplicantEmploymentOptions | null | undefined, usual: string) {
  if (!options) return usual;
  return options.jobTitles.find(title => key(title) === key(usual)) ?? '';
}
/** Which option the saved text means. Text from before the lists stays selectable, so nothing changes until the applicant changes it. */
function withCurrent(options: Option[], text: string) {
  const match = options.find(option => key(option.value) === key(text));
  if (match || !text.trim()) return { value: match?.value ?? '', options, unlisted: false };
  return { value: text, options: [...options, { value: text, label: text }], unlisted: true };
}

export function ApplicantEmployment({ options, prefilled, values, errors, editable, requested, hint, register, onChange }: {
  options: ApplicantEmploymentOptions; prefilled: boolean; values: Record<Name, string>; errors: Partial<Record<Name, string>>;
  editable: (name: FieldName) => boolean; requested: (name: FieldName) => boolean; hint: (name: FieldName) => ReactNode;
  register: (name: Name) => { ref: Ref<HTMLSelectElement>; name: string; onBlur: FocusEventHandler<HTMLSelectElement> }; onChange: (name: Name, value: string) => void;
}) {
  const chosenMc = key(values.mcName), independent = chosenMc === key(INDEPENDENT), notListed = chosenMc === key(NOT_LISTED);
  const mc = withCurrent([{ value: INDEPENDENT, label: INDEPENDENT }, ...options.mcs.map(name => ({ value: name, label: name })), { value: NOT_LISTED, label: 'My MC isn’t listed' }], values.mcName);
  const teams = options.teams.filter(team => key(team.mc) === chosenMc);
  // Independent and "not listed" MCs leave nothing to choose: the team follows from the MC.
  const fixedTeam = independent || notListed;
  const team = withCurrent(fixedTeam ? [{ value: independent ? INDEPENDENT : NOT_LISTED, label: independent ? INDEPENDENT : 'Your manager picks it' }]
    : [{ value: NO_TEAM, label: 'No team yet' }, ...teams.map(item => ({ value: item.value, label: item.led ? `${item.name} · ${item.value}` : item.name })), { value: NOT_LISTED, label: 'My team isn’t listed' }], values.teamLead);
  const title = withCurrent([...options.jobTitles.map(name => ({ value: name, label: name })), { value: NOT_LISTED, label: 'My job title isn’t listed' }], values.jobTitle);
  const box = (name: Name) => cn(requested(name) && 'rounded-md border border-warning-border bg-warning-background/40 p-3');
  const note = (name: Name, text?: string) => { const correction = hint(name); return correction || text ? <>{correction}{correction && text ? ' ' : ''}{text}</> : undefined; };
  const teamNote = independent ? 'Independent dispatchers have no team.' : notListed ? 'Your manager picks your MC and team before approval.' : team.unlisted ? EARLIER : chosenMc ? `Teams at ${mc.value}.` : undefined;
  return <>
    {prefilled && <Alert tone="info" title="Your manager filled in some details"><p>Check they’re right. Your manager confirms them before approval.</p></Alert>}
    <p className="text-sm text-muted-foreground">Choose your MC, team and job title. Your manager confirms them before approval. IT will assign your work phone number when setting up RingCentral.</p>
    <div className="grid gap-4">
      <Select {...register('mcName')} id="field-mcName" label="MC" aria-required width="full" placeholder="Choose your MC" value={mc.value} options={mc.options} disabled={!editable('mcName')} error={errors.mcName} hint={note('mcName', mc.unlisted ? EARLIER : undefined)} className={box('mcName')}
        onChange={event => { const next = event.target.value; onChange('mcName', next); onChange('teamLead', next === INDEPENDENT ? INDEPENDENT : next === NOT_LISTED ? NOT_LISTED : ''); }} />
      <Select {...register('teamLead')} id="field-teamLead" label="Team" aria-required width="full" placeholder={fixedTeam ? undefined : chosenMc ? 'Choose your team' : 'Choose your MC first'} value={team.value} options={chosenMc ? team.options : []} disabled={!editable('teamLead') || fixedTeam || !chosenMc} error={errors.teamLead} hint={note('teamLead', teamNote)} className={box('teamLead')}
        onChange={event => onChange('teamLead', event.target.value)} />
      <Select {...register('jobTitle')} id="field-jobTitle" label="Job title" aria-required width="full" placeholder="Choose your job title" value={title.value} options={title.options} disabled={!editable('jobTitle')} error={errors.jobTitle} hint={note('jobTitle', title.unlisted ? EARLIER : undefined)} className={box('jobTitle')}
        onChange={event => onChange('jobTitle', event.target.value)} />
    </div>
  </>;
}
