'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/field';
import { PendingHint } from '@/components/ui/pending-hint';
import { useToast } from '@/components/ui/toast';
import { PageCrumb } from '@/components/shell-context';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { CsvImport, type Added, type ImportSetup } from './csv-import';
import { useToday } from './driver-documents';
import { driverTypes, licenseTypes, US_STATES, workAuthorizationTypes } from './types';

export interface ExistingDriverOptions { staff: { id: string; name: string }[]; units: { id: string; number: string; kind: string; ownerOperator: boolean; owner: string }[];
  mcs: { id: string; name: string; dispatchers: { id: string; name: string; team: string | null }[] }[] }

const SETUP: ImportSetup = {
  columns: [['first_name', 'firstName'], ['last_name', 'lastName'], ['phone', 'phone'], ['email', 'email'], ['type', 'driverType'], ['license_class', 'licenseClass'], ['license_state', 'licenseState'],
    ['hired_on', 'hiredOn'], ['safety_manager', 'safetyManager'], ['license_expires', 'licenseExpiresOn'], ['medical_card_expires', 'medicalExpiresOn'], ['work_authorization', 'workAuthorization'],
    ['work_permit_expires', 'workPermitExpiresOn'], ['last_yearly_review', 'lastReviewOn'], ['unit', 'unit'], ['mc', 'mc'], ['dispatcher', 'dispatcher']],
  optional: ['email', 'hired_on', 'work_permit_expires', 'last_yearly_review', 'unit', 'mc', 'dispatcher'],
  template: [
    { firstName: 'Dana', lastName: 'Okafor', phone: '+1 469 555 0177', email: 'dana.okafor@example.test', driverType: 'Company driver', licenseClass: 'CDL Class A', licenseState: 'TX', hiredOn: '2023-05-15',
      safetyManager: 'Owen Staff', licenseExpiresOn: '2028-09-30', medicalExpiresOn: '2027-10-02', workAuthorization: 'Green card', lastReviewOn: '2026-02-14', unit: '233', mc: 'Northwind Freight', dispatcher: 'Taylor Brooks' },
    { firstName: 'Jamie', lastName: 'Cole', phone: '+1 312 555 0190', email: 'jamie.cole@example.test', driverType: 'Company driver', licenseClass: 'DL', licenseState: 'IL', hiredOn: '2024-08-01',
      safetyManager: 'Owen Staff', licenseExpiresOn: '2029-01-31', medicalExpiresOn: '2027-06-30', workAuthorization: 'Work permit', workPermitExpiresOn: '2027-03-15' }],
  noun: ['driver', 'drivers'], steps: ['Upload the file', 'Check the rows', 'Add drivers'], check: 'safety/drivers/existing/check', add: 'safety/drivers/existing/add', templateName: 'existing-drivers-template.csv',
  choiceLabels: { safetyManager: ['Safety Manager', 'Use this Safety Manager'], unit: ['Unit', 'Use this unit'], mc: ['MC', 'Use this MC'], dispatcher: ['Dispatcher', 'Use this dispatcher'] },
  guide: [{ label: 'Driver', value: 'First and last name, phone, email' }, { label: 'Type', value: 'Company driver or owner-operator, license class and state' },
    { label: 'Hired on', value: 'When they started driving for UGEM' }, { label: 'Safety Manager', value: 'The Safety staff member who looks after their file' },
    { label: 'Expiration dates', value: 'License and medical card. A work permit’s date, if that’s their work authorization' },
    { label: 'Last yearly review', value: 'The date of their last review of driving record, if you know it' },
    { label: 'Unit, MC and dispatcher', value: 'If they’re already working. Dispatch can assign them later otherwise' }],
  guideNote: 'Never SSNs, license numbers, birth dates, test results or medical details. Those stay in the paper file.',
  uploadNote: 'Add units first, in Safety › Units, so a row can name the unit the driver uses. Nothing is saved until you confirm on the last step, and the file itself is never kept.',
  addNote: 'They become Cleared straight away, with no application or new tests, and nobody is messaged. An expired card puts that driver on hold for Dispatch.',
  next: ['Each driver is Cleared from the day you add them, with the Safety Manager you choose. Their hire date is kept as it was.',
    'The license, medical card and work permit dates you type count as checked, so Expiring documents, reminders and holds work from day one. One that has already expired puts the driver on hold for Dispatch.',
    'On each driver’s page you confirm what their paper file holds. Nothing in it is retyped.',
    'Send each driver a catch-up link when you’re ready: they photograph their current documents and sign the current consent forms. No SSN, no new application.'],
};

/** Safety › Drivers › Add existing drivers (ExistingDriversAddScreen and ExistingDriversCheckScreen): a file first, one at a time for the odd driver. */
export function AddExistingDrivers({ options }: { options: ExistingDriverOptions }) {
  const router = useRouter(), toast = useToast(), [one, setOne] = useState(false);
  return <div className="space-y-6">
    <PageCrumb label="Add existing drivers" />
    <PageHeader title="Add existing drivers" description="For drivers already on the road with a paper qualification file. They become Cleared straight away, with no application or new tests, and nobody is messaged."
      action={<Button variant="outline" onClick={() => setOne(true)}><Plus aria-hidden="true" className="size-4" />Add one driver</Button>} />
    <CsvImport setup={SETUP} done={(result: Added, again) => <>
      <Alert tone="success" title={`Added ${result.added} ${result.added === 1 ? 'driver' : 'drivers'}`}><p>They’re Cleared now. Confirm each one’s paper file on their page and send them a catch-up link when you’re ready.</p></Alert>
      <div className="flex flex-wrap gap-2"><Button asChild><Link href="/safety/drivers?status=MISSING">See missing details</Link></Button><Button variant="outline" onClick={again}>Upload another file</Button></div></>} />
    {one && <AddOne options={options} onClose={() => setOne(false)} onAdded={id => { toast({ title: 'Driver added', description: 'They’re Cleared now. Nobody was messaged.' }); router.push(`/safety/drivers/${id}`); }} />}
  </div>;
}

/** One driver at a time (ExistingDriverFormScreen): the same fields and rules as the file, with the units and dispatchers to pick from. */
function AddOne({ options, onClose, onAdded }: { options: ExistingDriverOptions; onClose: () => void; onAdded: (id: string) => void }) {
  const today = useToday();
  const [type, setType] = useState('COMPANY'), [authorization, setAuthorization] = useState('GREEN_CARD'), [mcId, setMcId] = useState(''), [medical, setMedical] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mc = options.mcs.find(item => item.id === mcId);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const data = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
    setBusy(true); setError('');
    try {
      const at = (value: string | undefined) => value ? `@${value}` : '';
      const row = { row: 1, firstName: data.firstName, lastName: data.lastName, phone: data.phone, email: data.email, driverType: type, licenseClass: data.licenseClass, licenseState: data.licenseState,
        hiredOn: data.hiredOn, safetyManager: at(data.safetyManager), licenseExpiresOn: data.licenseExpiresOn, medicalExpiresOn: data.medicalExpiresOn, workAuthorization: authorization,
        workPermitExpiresOn: data.workPermitExpiresOn, lastReviewOn: data.lastReviewOn, unit: data.unit ? `@${data.unit}` : '', mc: at(mcId), dispatcher: mcId ? at(data.dispatcher) : '' };
      const result = await mutate<{ drivers: { row: number; id: string }[]; left: { problems: string[] }[] }>('safety/drivers/existing/add', 'POST', { rows: [row] });
      if (result.drivers[0]) onAdded(result.drivers[0].id);
      else setError(result.left[0]?.problems.join(' ') || 'Check the details and try again.');
    } catch (failure) { setError(errorMessage(failure, 'Unable to add them. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  // A company driver drives a truck owner's unit; an owner-operator's own truck is added on Units once they're added.
  const units = type === 'OWNER_OPERATOR' ? [] : options.units.filter(unit => !unit.ownerOperator);
  return <Dialog open onClose={onClose} busy={busy} size="lg" title="Add one existing driver" description="They become Cleared straight away, with no application or new tests. Nobody is messaged."
    actions={<Button form="add-existing-driver" type="submit" disabled={busy}><Plus aria-hidden="true" className="size-4" />{busy ? 'Adding…' : 'Add driver'}</Button>}>
    <form id="add-existing-driver" onSubmit={submit} className="space-y-5"><fieldset disabled={busy} className="min-w-0 space-y-5">
      <div className="grid gap-4 sm:grid-cols-2"><Input name="firstName" label="First name" required maxLength={100} width="full" /><Input name="lastName" label="Last name" required maxLength={100} width="full" /></div>
      <div className="grid gap-4 sm:grid-cols-2"><Input name="phone" label="Phone" type="tel" required maxLength={40} width="full" /><Input name="email" label="Email" optional type="email" maxLength={254} width="full" hint="The catch-up link is checked against it." /></div>
      <div className="grid gap-4 sm:grid-cols-2"><Select label="Type" value={type} onChange={event => setType(event.target.value)} width="full" options={Object.entries(driverTypes).map(([value, label]) => ({ value, label }))} />
        <Input name="hiredOn" label="Hired on" optional type="date" width="full" max={today ?? undefined} /></div>
      <div className="grid gap-4 sm:grid-cols-2"><Select name="licenseClass" label="License class" required placeholder="Choose" width="full" options={Object.entries(licenseTypes).map(([value, label]) => ({ value, label }))} />
        <Select name="licenseState" label="License state" required placeholder="Choose" width="full" options={[...US_STATES]} /></div>
      <Select name="safetyManager" label="Safety Manager" required placeholder="Choose a Safety Manager" width="full" options={options.staff.map(item => ({ value: item.id, label: item.name }))} />
      <Card><CardHeader title="From the paper file" description="Type the dates printed on their current documents. They count as checked until a scan replaces them." />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2"><Input name="licenseExpiresOn" label="License expires" type="date" required width="full" />
            <Input name="medicalExpiresOn" label="Medical card expires" type="date" required width="full" value={medical} onChange={event => setMedical(event.target.value)}
              error={medical && today && medical < today ? 'This date has passed. They’ll be added on hold for Dispatch until a newer card is checked.' : undefined} /></div>
          <div className="grid gap-4 sm:grid-cols-2"><Select label="Work authorization" value={authorization} onChange={event => setAuthorization(event.target.value)} width="full" options={Object.entries(workAuthorizationTypes).map(([value, label]) => ({ value, label }))}
            hint={authorization === 'US_PASSPORT' || authorization === 'GREEN_CARD' ? 'A US passport or green card has no date to watch.' : undefined} />
            {authorization === 'WORK_PERMIT' || authorization === 'OTHER' ? <Input name="workPermitExpiresOn" label={authorization === 'WORK_PERMIT' ? 'Work permit expires' : 'Expires'} optional={authorization === 'OTHER'} required={authorization === 'WORK_PERMIT'} type="date" width="full" /> : <span className="max-sm:hidden" />}</div>
          <Input name="lastReviewOn" label="Last yearly review" optional type="date" width="sm" max={today ?? undefined} hint="Leave it empty if you don’t know: the review shows as due now." />
        </CardBody></Card>
      <Card><CardHeader title="Working now" description="Leave these empty and Dispatch assigns them later." />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2"><Select label="MC" value={mcId} onChange={event => setMcId(event.target.value)} placeholder="Not assigned yet" width="full" options={options.mcs.map(item => ({ value: item.id, label: item.name }))} />
            <Select key={mcId} name="dispatcher" label="Dispatcher" required={!!mcId} disabled={!mcId} placeholder={mcId ? 'Choose a dispatcher' : 'Choose an MC first'} width="full" options={(mc?.dispatchers ?? []).map(item => ({ value: item.id, label: item.team ? `${item.name} · ${item.team}` : item.name }))} /></div>
          {/* The unit is kept with the dispatch assignment, so it waits for the MC; an owner-operator's own truck is added on Units afterwards. */}
          <Select key={`${type}-${mcId}`} name="unit" label="Unit" placeholder="No unit yet" width="full" disabled={type === 'OWNER_OPERATOR' || !mcId}
            hint={type === 'OWNER_OPERATOR' ? 'Add their own truck on Units once they’re added.' : mcId ? undefined : 'Choose the MC and dispatcher first: the unit is kept with their assignment.'}
            options={units.map(unit => ({ value: unit.id, label: `${unit.number} · ${unit.kind === 'SEMI' ? 'Semi truck' : 'Pickup'} · ${unit.owner}` }))} />
        </CardBody></Card>
      <p className="text-[13px] text-muted-foreground">Never SSNs, license numbers, birth dates, test results or medical details.</p>
      <Notice message={error} error /><PendingHint pending={busy} />
    </fieldset></form>
  </Dialog>;
}
