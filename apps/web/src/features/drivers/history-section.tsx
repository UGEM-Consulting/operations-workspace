'use client';
import { useState } from 'react';
import { ArrowLeft, CircleCheck, Plus } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, RadioGroup, Select, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/status-badge';
import { licenseTypes, US_STATES } from '@/features/safety/types';
import { addMonths, addressesCovered, DRIVING_YEARS, HISTORY_YEARS, jobGaps, type DriverHistory, type HistoryAccident, type HistoryAddress, type HistoryExperience, type HistoryJob, type HistoryLicense,
  type HistoryTicket, type YesNo } from './history-rules';

export type HistoryKind = 'address' | 'job' | 'accident' | 'ticket' | 'license' | 'experience';
export interface HistoryEditing { kind: HistoryKind; id: string | null }
const states = US_STATES.map(state => ({ value: state, label: state }));
const yesNo = [{ value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes' }];
const lists: Record<HistoryKind, 'addresses' | 'jobs' | 'accidentList' | 'ticketList' | 'licenseList' | 'experience'> = { address: 'addresses', job: 'jobs', accident: 'accidentList', ticket: 'ticketList', license: 'licenseList', experience: 'experience' };
const titles: Record<HistoryKind, string> = { address: 'a previous address', job: 'a job', accident: 'an accident', ticket: 'a ticket', license: 'another license', experience: 'driving experience' };
/** "2024-03" as "Mar 2024". */
export const monthLabel = (value: string) => new Date(`${value}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const span = (from: string, to: string | null) => from === to ? monthLabel(from) : `${monthLabel(from)} – ${to ? monthLabel(to) : 'now'}`;
/** The ids of the history sections, for moving focus to the first one with a problem. */
export const historySectionIds = { lived: 'history-lived', worked: 'history-worked', record: 'history-record' };
export function historySection(code: string) {
  return ['history:currentSince', 'history:addresses'].includes(code) ? historySectionIds.lived : ['history:accidents', 'history:tickets', 'history:licenses', 'history:licenseTrouble'].includes(code)
    ? historySectionIds.record : code.startsWith('history:') ? historySectionIds.worked : null;
}

function Entry({ title, meta, onEdit, children }: { title: string; meta: string; onEdit?: () => void; children?: React.ReactNode }) {
  return <div className="space-y-2 rounded-md border border-border p-4">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium [overflow-wrap:anywhere]">{title}</p><p className="text-[13px] text-muted-foreground">{meta}</p></div>
      {onEdit && <Button type="button" size="sm" variant="ghost" onClick={onEdit}>Edit<span className="sr-only">: {title}</span></Button>}</div>
    {children}
  </div>;
}
function Problem({ show, children }: { show: boolean; children: React.ReactNode }) {
  return show ? <p className="text-sm font-medium text-danger">{children}</p> : null;
}

/**
 * The driver's address and work history in their application (FMCSA §391.21), designed as DriverHistoryPhoneScreen:
 * addresses for 3 years (the current one comes from Contact and home address), every job for 3 years and driving jobs for
 * 10 with each gap explained, then accidents, tickets and other licenses. Entries open their own form (HistoryEditor).
 * `missing` holds the history codes a refused submission named.
 */
export function HistorySections({ history, onChange, onEdit, now, currentAddress, missing, Section }: {
  history: DriverHistory; onChange: (history: DriverHistory) => void; onEdit: (editing: HistoryEditing) => void; now: string | undefined; currentAddress: string;
  missing: string[]; Section: (props: { title: string; hint?: string; id?: string; children: React.ReactNode }) => React.ReactNode;
}) {
  const set = (changes: Partial<DriverHistory>) => onChange({ ...history, ...changes });
  const jobs = [...(history.jobs ?? [])].sort((a, b) => (b.toMonth ?? '9999') .localeCompare(a.toMonth ?? '9999') || b.fromMonth.localeCompare(a.fromMonth));
  const addresses = [...(history.addresses ?? [])].sort((a, b) => b.toMonth.localeCompare(a.toMonth));
  const gaps = now ? jobGaps(history, now) : [];
  const explained = (from: string, to: string) => history.gaps?.find(gap => gap.from === from && gap.to === to)?.explanation ?? '';
  function explain(from: string, to: string, explanation: string) {
    set({ gaps: [...(history.gaps ?? []).filter(gap => !(gap.from === from && gap.to === to) && gaps.some(open => open.from === gap.from && open.to === gap.to)), { from, to, explanation }] });
  }
  const oldest = jobs.map(job => job.fromMonth).sort()[0];
  const drivingStart = now ? addMonths(now, -DRIVING_YEARS * 12 + 1) : null, historyStart = now ? addMonths(now, -HISTORY_YEARS * 12 + 1) : null;
  const drivingShort = !!oldest && !!drivingStart && oldest > drivingStart;
  // Jobs and gaps, newest first: each gap sits right after the job that follows it.
  const rows: ({ job: HistoryJob } | { gap: { from: string; to: string } })[] = [...jobs.map(job => ({ job })), ...gaps.map(gap => ({ gap }))]
    .sort((a, b) => ('gap' in b ? b.gap.to : b.job.toMonth ?? '9999').localeCompare('gap' in a ? a.gap.to : a.job.toMonth ?? '9999'));
  const has = (code: string) => missing.includes(code);
  return <>
    <Section id={historySectionIds.lived} title="Where you’ve lived" hint="Every address for the last 3 years, newest first. Your current address comes from Contact and home address.">
      <Entry title={currentAddress || 'Your current address'} meta="Current address">
        <Input id="history-current-since" label="Lived here since" type="month" width="sm" max={now} value={history.currentSince ?? ''} onChange={event => set({ currentSince: event.target.value || undefined })}
          error={has('history:currentSince') ? 'Enter the month you moved in.' : undefined} />
      </Entry>
      {addresses.map(address => <Entry key={address.id} title={`${address.line1}, ${address.city}, ${address.state} ${address.zip}`} meta={span(address.fromMonth, address.toMonth)}
        onEdit={() => onEdit({ kind: 'address', id: address.id })} />)}
      {history.currentSince && now && addressesCovered(history, now) ? <p className="flex items-center gap-1.5 text-sm font-medium text-success"><CircleCheck aria-hidden="true" className="size-4" />3 years covered</p>
        : history.currentSince && historyStart && <Alert tone="info" title="Still needed">Add where you lived before {monthLabel(history.currentSince)}, back to {monthLabel(historyStart)}.</Alert>}
      <Problem show={has('history:addresses')}>Add your addresses for the last 3 years.</Problem>
      <Button type="button" variant="outline" className="w-full" onClick={() => onEdit({ kind: 'address', id: null })}><Plus aria-hidden="true" className="size-4" />Add a previous address</Button>
    </Section>
    <Section id={historySectionIds.worked} title="Where you’ve worked" hint="Every job for the last 3 years, and every job driving a commercial vehicle for the last 10. Safety asks your DOT-regulated employers about your safety record.">
      {!jobs.length && <p className="text-sm text-muted-foreground">No jobs yet. Add your current or most recent job first.</p>}
      {rows.map(row => 'job' in row ? <Entry key={row.job.id} title={row.job.company} meta={`${row.job.position} · ${span(row.job.fromMonth, row.job.toMonth)}`} onEdit={() => onEdit({ kind: 'job', id: row.job.id })}>
        {(row.job.drove === 'YES' || row.job.dotTesting === 'YES') && <div className="flex flex-wrap gap-2">
          {row.job.drove === 'YES' && <Badge label="Drove a commercial vehicle" tone="info" />}{row.job.dotTesting === 'YES' && <Badge label="DOT drug testing" tone="info" />}</div>}
      </Entry> : <div key={`${row.gap.from}_${row.gap.to}`} className="space-y-3">
        <Alert tone="warning" title={`Gap: ${span(row.gap.from, row.gap.to)}`}>Tell Safety what you did in this time, for example looking for work, family or school.</Alert>
        <Textarea id={`history-gap-${row.gap.from}`} label="What you did in this gap" rows={2} maxLength={500} value={explained(row.gap.from, row.gap.to)} onChange={event => explain(row.gap.from, row.gap.to, event.target.value)}
          error={has(`history:gap:${row.gap.from}_${row.gap.to}`) ? 'Explain this gap.' : undefined} />
      </div>)}
      {drivingShort && <>
        <Alert tone="info" title={`Still needed: driving jobs before ${monthLabel(oldest!)}`}>Add any job driving a commercial vehicle from {monthLabel(drivingStart!)} to {monthLabel(oldest!)}, or tick the box if you had none.</Alert>
        <Checkbox label={`I didn’t drive a commercial vehicle for work before ${monthLabel(oldest!)}`} checked={history.noEarlierDriving === true} onChange={event => set({ noEarlierDriving: event.target.checked })} />
      </>}
      <Problem show={has('history:driving')}>Add your driving jobs for the last 10 years, or tick the box.</Problem>
      <Problem show={has('history:dates')}>Check the months: a job or address ends before it starts, or is in the future.</Problem>
      <Button type="button" variant="outline" className="w-full" onClick={() => onEdit({ kind: 'job', id: null })}><Plus aria-hidden="true" className="size-4" />Add a job</Button>
    </Section>
    <Section title="Driving experience" hint="Every kind of vehicle you’ve driven for work, for example a pickup with a car-hauler trailer or a semi with a dry van.">
      {(history.experience ?? []).map(item => <Entry key={item.id} title={item.vehicle} meta={`${span(item.fromMonth, item.toMonth)} · about ${item.miles.toLocaleString('en-US')} miles`} onEdit={() => onEdit({ kind: 'experience', id: item.id })} />)}
      {(history.experience ?? []).length < 10 && <Button type="button" variant="outline" className="w-full" onClick={() => onEdit({ kind: 'experience', id: null })}><Plus aria-hidden="true" className="size-4" />Add experience</Button>}
    </Section>
    <Section id={historySectionIds.record} title="Accidents, tickets and licenses" hint="For the last 3 years. Safety checks this against your driving record.">
      <RadioGroup name="history-accidents" label="Any accidents while driving a commercial vehicle?" value={history.accidents ?? ''} onChange={value => set({ accidents: value as YesNo })} options={yesNo} />
      {history.accidents === 'YES' && <>
        {(history.accidentList ?? []).map(item => <Entry key={item.id} title={item.description} meta={`${monthLabel(item.month)} · ${item.state}`} onEdit={() => onEdit({ kind: 'accident', id: item.id })} />)}
        <Button type="button" variant="outline" className="w-full" onClick={() => onEdit({ kind: 'accident', id: null })}><Plus aria-hidden="true" className="size-4" />Add an accident</Button></>}
      <Problem show={has('history:accidents')}>{history.accidents === 'YES' ? 'Add each accident.' : 'Answer this question.'}</Problem>
      <RadioGroup name="history-tickets" label="Any traffic tickets, other than parking?" value={history.tickets ?? ''} onChange={value => set({ tickets: value as YesNo })} options={yesNo} />
      {history.tickets === 'YES' && <>
        {(history.ticketList ?? []).map(item => <Entry key={item.id} title={item.violation} meta={`${monthLabel(item.month)} · ${item.state} · ${item.vehicle === 'CMV' ? 'in a commercial vehicle' : 'in another vehicle'}`} onEdit={() => onEdit({ kind: 'ticket', id: item.id })} />)}
        <Button type="button" variant="outline" className="w-full" onClick={() => onEdit({ kind: 'ticket', id: null })}><Plus aria-hidden="true" className="size-4" />Add a ticket</Button></>}
      <Problem show={has('history:tickets')}>{history.tickets === 'YES' ? 'Add each ticket.' : 'Answer this question.'}</Problem>
      <RadioGroup name="history-licenses" label="Any other driver’s license in the last 3 years?" value={history.otherLicenses ?? ''} onChange={value => set({ otherLicenses: value as YesNo })}
        options={[{ value: 'NO', label: 'No, only the one above' }, { value: 'YES', label: 'Yes' }]} />
      {history.otherLicenses === 'YES' && <>
        {(history.licenseList ?? []).map(item => <Entry key={item.id} title={`${item.state} · ${licenseTypes[item.licenseClass as keyof typeof licenseTypes] ?? item.licenseClass}`} meta={`Number ${item.number}`} onEdit={() => onEdit({ kind: 'license', id: item.id })} />)}
        {(history.licenseList ?? []).length < 5 && <Button type="button" variant="outline" className="w-full" onClick={() => onEdit({ kind: 'license', id: null })}><Plus aria-hidden="true" className="size-4" />Add a license</Button>}</>}
      <Problem show={has('history:licenses')}>{history.otherLicenses === 'YES' ? 'Add each other license.' : 'Answer this question.'}</Problem>
      <RadioGroup name="history-trouble" label="Has a license ever been denied, suspended or revoked?" value={history.licenseTrouble ?? ''} onChange={value => set({ licenseTrouble: value as YesNo })}
        options={[{ value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes', description: 'Safety will ask you about it.' }]} />
      {history.licenseTrouble === 'YES' && <Textarea id="history-license-trouble" label="What happened" rows={2} maxLength={500} value={history.licenseTroubleNote ?? ''} onChange={event => set({ licenseTroubleNote: event.target.value })}
        error={has('history:licenseTrouble') ? 'Tell Safety what happened.' : undefined} />}
      <Problem show={has('history:licenseTrouble') && history.licenseTrouble !== 'YES'}>Answer this question.</Problem>
    </Section>
  </>;
}

/**
 * Adding or changing one entry, in place of the application (DriverJobFormPhoneScreen for a job): the application stays on
 * the page, hidden, so nothing typed there is lost. Saving returns the whole history; the page then saves the draft.
 */
export function HistoryEditor({ editing, history, now, busy, error, onSave, onCancel }: {
  editing: HistoryEditing; history: DriverHistory; now: string | undefined; busy: boolean; error: string; onSave: (history: DriverHistory) => void; onCancel: () => void;
}) {
  const list = lists[editing.kind];
  const current = editing.id ? (history[list] as { id: string }[] | undefined)?.find(item => item.id === editing.id) : undefined;
  const [stillThere, setStillThere] = useState((editing.kind === 'job' || editing.kind === 'experience') && !!current && (current as HistoryJob | HistoryExperience).toMonth === null);
  const [problem, setProblem] = useState('');
  const value = (key: string) => (current as Record<string, string | null> | undefined)?.[key] ?? '';
  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const id = editing.id ?? crypto.randomUUID(), trimmed = Object.fromEntries(Object.entries(data).map(([key, text]) => [key, text.trim()]));
    if ((editing.kind === 'job' && !(data.drove && data.fmcsr && data.dotTesting)) || (editing.kind === 'ticket' && !data.vehicle)) return setProblem('Answer every question.');
    let item: HistoryAddress | HistoryJob | HistoryAccident | HistoryTicket | HistoryLicense | HistoryExperience;
    if (editing.kind === 'address') item = { id, line1: trimmed.line1, city: trimmed.city, state: trimmed.state, zip: trimmed.zip, fromMonth: trimmed.fromMonth, toMonth: trimmed.toMonth };
    else if (editing.kind === 'job') item = { id, company: trimmed.company, city: trimmed.city, state: trimmed.state, phone: trimmed.phone, position: trimmed.position, fromMonth: trimmed.fromMonth,
      toMonth: stillThere ? null : trimmed.toMonth, drove: trimmed.drove as YesNo, fmcsr: trimmed.fmcsr as HistoryJob['fmcsr'], dotTesting: trimmed.dotTesting as HistoryJob['dotTesting'], reasonLeft: trimmed.reasonLeft ?? '',
      ...(trimmed.contactName ? { contactName: trimmed.contactName } : {}), ...(trimmed.contactEmail ? { contactEmail: trimmed.contactEmail } : {}), ...(stillThere && trimmed.mayContact ? { mayContact: trimmed.mayContact as YesNo } : {}) };
    else if (editing.kind === 'experience') item = { id, vehicle: trimmed.vehicle, fromMonth: trimmed.fromMonth, toMonth: stillThere ? null : trimmed.toMonth, miles: Math.max(0, Math.round(Number(trimmed.miles) || 0)) };
    else if (editing.kind === 'accident') item = { id, month: trimmed.month, state: trimmed.state, description: trimmed.description };
    else if (editing.kind === 'ticket') item = { id, month: trimmed.month, state: trimmed.state, violation: trimmed.violation, vehicle: trimmed.vehicle as 'CMV' | 'OTHER' };
    else item = { id, state: trimmed.state, number: trimmed.number.toUpperCase(), licenseClass: trimmed.licenseClass };
    const from = 'fromMonth' in item ? item.fromMonth : null, to = 'toMonth' in item ? item.toMonth : null;
    if (from && to && to < from) return setProblem('The last month can’t be before the first.');
    if (now && [from, to, 'month' in item ? item.month : null].some(month => month && month > now)) return setProblem('A month can’t be in the future.');
    setProblem('');
    const items = (history[list] as { id: string }[] | undefined) ?? [];
    onSave({ ...history, [list]: current ? items.map(row => row.id === id ? item : row) : [...items, item] });
  }
  function remove() { onSave({ ...history, [list]: ((history[list] as { id: string }[] | undefined) ?? []).filter(row => row.id !== editing.id) }); }
  const heading = `${current ? 'Change' : 'Add'} ${titles[editing.kind]}`;
  return <form onSubmit={save} className="space-y-6">
    <div><Button type="button" variant="ghost" onClick={onCancel}><ArrowLeft aria-hidden="true" className="size-4" />Back to your application</Button>
      <h1 className="mt-2 text-2xl font-normal">{heading}</h1></div>
    <fieldset disabled={busy} className="space-y-4 rounded-lg border border-border bg-card p-5 sm:p-6">
      <legend className="sr-only">{heading}</legend>
      {editing.kind === 'address' && <>
        <Input label="Street address" id="entry-line1" name="line1" required maxLength={200} defaultValue={value('line1')} autoComplete="off" />
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Input label="City" id="entry-city" name="city" required maxLength={100} defaultValue={value('city')} />
          <Select label="State" id="entry-state" name="state" required placeholder="–" options={states} defaultValue={value('state')} />
          <Input label="ZIP code" id="entry-zip" name="zip" required inputMode="numeric" pattern="\d{5}(-\d{4})?" maxLength={10} defaultValue={value('zip')} />
        </div>
        <div className="flex flex-wrap gap-4"><Input label="From" id="entry-fromMonth" name="fromMonth" type="month" required width="sm" max={now} defaultValue={value('fromMonth')} />
          <Input label="To" id="entry-toMonth" name="toMonth" type="month" required width="sm" max={now} defaultValue={value('toMonth')} /></div>
      </>}
      {editing.kind === 'job' && <>
        <Input label="Company name" id="entry-company" name="company" required maxLength={200} defaultValue={value('company')} />
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Input label="City" id="entry-city" name="city" required maxLength={100} defaultValue={value('city')} />
          <Select label="State" id="entry-state" name="state" required placeholder="–" options={states} defaultValue={value('state')} />
        </div>
        <Input label="Company phone" id="entry-phone" name="phone" type="tel" required maxLength={40} width="md" defaultValue={value('phone')} hint="Safety calls or writes to ask about your safety record." />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Contact person" id="entry-contactName" name="contactName" optional maxLength={100} defaultValue={value('contactName')} hint="For example, their dispatch or safety manager." />
          <Input label="Contact email" id="entry-contactEmail" name="contactEmail" type="email" optional maxLength={254} defaultValue={value('contactEmail')} />
        </div>
        <Input label="Your position" id="entry-position" name="position" required maxLength={100} defaultValue={value('position')} />
        <div className="flex flex-wrap gap-4"><Input label="From" id="entry-fromMonth" name="fromMonth" type="month" required width="sm" max={now} defaultValue={value('fromMonth')} />
          {!stillThere && <Input label="To" id="entry-toMonth" name="toMonth" type="month" required width="sm" max={now} defaultValue={value('toMonth')} />}</div>
        <Checkbox label="I still work here" checked={stillThere} onChange={event => setStillThere(event.target.checked)} />
        <RadioGroup name="drove" label="Did you drive a commercial vehicle for them?" defaultValue={value('drove')} options={yesNo.slice().reverse()} />
        <RadioGroup name="fmcsr" label="Were you subject to the federal motor carrier safety rules there?" hint="For example, you had a DOT medical card and kept logs." defaultValue={value('fmcsr')}
          options={[{ value: 'YES', label: 'Yes' }, { value: 'NO', label: 'No' }, { value: 'UNSURE', label: 'Not sure' }]} />
        <RadioGroup name="dotTesting" label="Were you in their DOT drug and alcohol testing program?" defaultValue={value('dotTesting')}
          options={[{ value: 'YES', label: 'Yes' }, { value: 'NO', label: 'No' }, { value: 'UNSURE', label: 'Not sure' }]} />
        {!stillThere && <Input label="Why you left" id="entry-reasonLeft" name="reasonLeft" required maxLength={200} defaultValue={value('reasonLeft')} />}
        {stillThere && <RadioGroup name="mayContact" label="May Safety contact this employer now?" hint="If not, they’ll ask once you’re hired." defaultValue={value('mayContact')} options={yesNo.slice().reverse()} />}
      </>}
      {editing.kind === 'experience' && <>
        <Input label="Vehicle" id="entry-vehicle" name="vehicle" required maxLength={100} defaultValue={value('vehicle')} hint="For example: pickup with a car-hauler trailer." />
        <div className="flex flex-wrap gap-4"><Input label="From" id="entry-fromMonth" name="fromMonth" type="month" required width="sm" max={now} defaultValue={value('fromMonth')} />
          {!stillThere && <Input label="To" id="entry-toMonth" name="toMonth" type="month" required width="sm" max={now} defaultValue={value('toMonth')} />}</div>
        <Checkbox label="I still drive this" checked={stillThere} onChange={event => setStillThere(event.target.checked)} />
        <Input label="About how many miles" id="entry-miles" name="miles" type="number" required min={0} max={5000000} width="sm" defaultValue={value('miles')} />
      </>}
      {(editing.kind === 'accident' || editing.kind === 'ticket') && <div className="flex flex-wrap gap-4">
        <Input label="Month" id="entry-month" name="month" type="month" required width="sm" max={now} min={now ? addMonths(now, -HISTORY_YEARS * 12 + 1) : undefined} defaultValue={value('month')} />
        <Select label="State" id="entry-state" name="state" required placeholder="–" options={states} defaultValue={value('state')} />
      </div>}
      {editing.kind === 'accident' && <Textarea label="What happened" id="entry-description" name="description" required rows={3} maxLength={300} defaultValue={value('description')} hint="For example: rear-ended at a light, no injuries." />}
      {editing.kind === 'ticket' && <>
        <Input label="Violation" id="entry-violation" name="violation" required maxLength={200} defaultValue={value('violation')} hint="For example: speeding, 11 mph over." />
        <RadioGroup name="vehicle" label="What were you driving?" defaultValue={value('vehicle')} options={[{ value: 'CMV', label: 'A commercial vehicle' }, { value: 'OTHER', label: 'Another vehicle' }]} />
      </>}
      {editing.kind === 'license' && <div className="grid gap-4 sm:grid-cols-3">
        <Select label="Issuing state" id="entry-state" name="state" required placeholder="–" options={states} defaultValue={value('state')} />
        <Input label="License number" id="entry-number" name="number" required maxLength={20} autoCapitalize="characters" spellCheck={false} defaultValue={value('number')} />
        <Select label="Class" id="entry-licenseClass" name="licenseClass" required placeholder="Choose a class" defaultValue={value('licenseClass')} options={Object.entries(licenseTypes).map(([key, label]) => ({ value: key, label }))} />
      </div>}
    </fieldset>
    <Notice message={problem || error} error />
    <div className="flex flex-wrap gap-3 border-t pt-5">
      <Button type="submit" disabled={busy}>{busy ? 'Saving…' : `Save ${editing.kind === 'license' ? 'license' : editing.kind === 'experience' ? 'experience' : editing.kind}`}</Button>
      {current && <Button type="button" variant="outline" className="text-danger" disabled={busy} onClick={remove}>Remove</Button>}
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
    </div>
  </form>;
}
