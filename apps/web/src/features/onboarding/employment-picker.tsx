'use client';
import { useState } from 'react';
import { Select } from '@/components/ui/field';

export interface EmploymentOptions { mcs: { id: string; name: string }[]; teams: { id: string; name: string; mcId: string; lead: string | null }[]; jobTitles: { id: string; name: string }[] }
export interface Employment { mcName: string; teamLead: string; jobTitle: string }
const INDEPENDENT = 'INDEPENDENT';
const key = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

/** Turns existing assignment text into list choices: names compare ignoring case and spacing, as the lists do. */
function initial(options: EmploymentOptions, value: Employment) {
  const mc = key(value.mcName) === 'independent' ? INDEPENDENT : options.mcs.find(item => key(item.name) === key(value.mcName))?.id ?? '';
  const lead = key(value.teamLead);
  // A team matches by its lead, by its own name, or by the name the lists gave it ("Lee Lead team", with the MC added
  // as "Lee Lead team (Northwind)" when the same lead text appears under two MCs).
  const named = (name: string) => [lead, `${lead} team`].includes(key(name)) || key(name).startsWith(`${lead} team (`);
  const team = lead === 'independent' ? INDEPENDENT : options.teams.find(item => item.mcId === mc && (key(item.lead ?? '') === lead || named(item.name)))?.id ?? '';
  const title = options.jobTitles.find(item => key(item.name) === key(value.jobTitle))?.id ?? '';
  return { mc, team: mc === INDEPENDENT ? INDEPENDENT : team, title };
}
type Choice = ReturnType<typeof initial>;
function asText(options: EmploymentOptions, choice: Choice): Employment {
  const team = options.teams.find(item => item.id === choice.team);
  return { mcName: choice.mc === INDEPENDENT ? 'Independent' : options.mcs.find(item => item.id === choice.mc)?.name ?? '',
    teamLead: choice.team === INDEPENDENT ? 'Independent' : team ? team.lead ?? team.name : '',
    jobTitle: options.jobTitles.find(item => item.id === choice.title)?.name ?? '' };
}
/** The starting value for a form using the picker: existing text matched to the lists, empty where nothing matches. */
export function pickedEmployment(options: EmploymentOptions, text: Employment) { return asText(options, initial(options, text)); }

/**
 * MC, team and job title picked from the managed lists. The choice is reported as the same text the API has always
 * taken: the MC name, the team lead's name (or the team's name while it has no lead) and the job title.
 * `optional` lets each be left unset (invitations); otherwise each needs a choice (approval).
 */
export function EmploymentPicker({ options, original, onChange, optional = false, disabled = false }: { options: EmploymentOptions; original: Employment; onChange: (next: Employment) => void; optional?: boolean; disabled?: boolean }) {
  const [choice, setChoice] = useState(() => initial(options, original));
  const teams = options.teams.filter(team => team.mcId === choice.mc);
  function update(next: Choice) { setChoice(next); onChange(asText(options, next)); }
  // Text that matches no list entry (typed before the lists existed) is shown so the manager can pick its match.
  const unmatched = (text: string, picked: string) => !picked && text.trim() ? `Entered as “${text.trim()}”, which isn’t in the list. Pick the matching entry.` : undefined;
  return <div className="space-y-4">
    <Select label="MC" name="mcId" value={choice.mc} disabled={disabled} required={!optional} optional={optional} width="full" placeholder={optional ? 'Let the applicant choose' : 'Choose an MC'}
      onChange={event => update({ ...choice, mc: event.target.value, team: event.target.value === INDEPENDENT ? INDEPENDENT : '' })}
      options={[{ value: INDEPENDENT, label: 'Independent' }, ...options.mcs.map(mc => ({ value: mc.id, label: mc.name }))]} hint={unmatched(original.mcName, choice.mc)} />
    <Select label="Team" name="teamId" value={choice.team} disabled={disabled || !choice.mc || choice.mc === INDEPENDENT} required={!optional} optional={optional} width="full"
      placeholder={choice.mc === INDEPENDENT ? undefined : choice.mc ? 'Choose a team' : 'Choose an MC first'} onChange={event => update({ ...choice, team: event.target.value })}
      options={choice.mc === INDEPENDENT ? [{ value: INDEPENDENT, label: 'Independent' }] : [...teams.map(team => ({ value: team.id, label: team.lead ? `${team.name} · ${team.lead}` : team.name })), ...(choice.mc ? [{ value: INDEPENDENT, label: 'No team (independent)' }] : [])]}
      hint={choice.mc && choice.mc !== INDEPENDENT && !teams.length ? 'This MC has no teams yet. Add one in Dispatch › Teams.' : unmatched(original.teamLead, choice.team)} />
    <Select label="Job title" name="jobTitleId" value={choice.title} disabled={disabled} required={!optional} optional={optional} width="full" placeholder={optional ? 'Let the applicant choose' : 'Choose a job title'}
      onChange={event => update({ ...choice, title: event.target.value })} options={options.jobTitles.map(title => ({ value: title.id, label: title.name }))} hint={unmatched(original.jobTitle, choice.title)} />
  </div>;
}
