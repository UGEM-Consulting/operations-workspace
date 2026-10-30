'use client';
import { Notice } from '@/components/ui/alert';
import { Input, Select, Textarea } from '@/components/ui/field';
import { driverTypes, licenseTypes, US_STATES, type DriverProfile, type SafetyPeople } from './types';

/** The request body for a new lead or an edit, from the driver form: empty optional fields are sent as null. */
export function driverBody(form: FormData) {
  const value = (key: string) => { const text = String(form.get(key) ?? '').trim(); return text === '' ? null : text; };
  const years = value('experienceYears');
  return { firstName: value('firstName') ?? '', lastName: value('lastName') ?? '', phone: value('phone') ?? '', email: value('email'), driverType: value('driverType'),
    licenseType: value('licenseType'), licenseState: value('licenseState'), experienceYears: years === null ? null : Number(years), source: value('source'), notes: value('notes'),
    ...(form.has('safetyLeadId') ? { safetyLeadId: value('safetyLeadId') } : {}) };
}

/**
 * A driver's contact and license details. The Safety lead is chosen only by Safety leads, managers and administrators
 * (`leads` given); safety staff edit details only.
 */
export function DriverForm({ id, driver, leads, defaultLeadId, onSubmit, error }: { id: string; driver?: DriverProfile; leads?: SafetyPeople['leads']; defaultLeadId?: string;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void; error: string }) {
  return <form id={id} onSubmit={onSubmit} className="space-y-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <Input label="First name" name="firstName" defaultValue={driver?.firstName} required maxLength={100} autoComplete="off" width="full" />
      <Input label="Last name" name="lastName" defaultValue={driver?.lastName} required maxLength={100} autoComplete="off" width="full" />
      <Input label="Phone" name="phone" type="tel" defaultValue={driver?.phone} required maxLength={40} autoComplete="off" width="full" />
      <Input label="Email" name="email" type="email" optional defaultValue={driver?.email ?? ''} maxLength={254} autoComplete="off" width="full" />
    </div>
    <Select label="Driver type" name="driverType" defaultValue={driver?.driverType ?? ''} required placeholder="Choose a type" width="full"
      options={Object.entries(driverTypes).map(([value, label]) => ({ value, label }))} />
    <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <Select label="License" name="licenseType" optional defaultValue={driver?.licenseType ?? ''} placeholder="Not known yet" width="full"
        options={Object.entries(licenseTypes).map(([value, label]) => ({ value, label }))} />
      <Select label="State" name="licenseState" optional defaultValue={driver?.licenseState ?? ''} placeholder="–" width="full" options={US_STATES.map(state => ({ value: state, label: state }))} />
      <Input label="Years driving" name="experienceYears" type="number" min={0} max={60} step={1} optional defaultValue={driver?.experienceYears ?? ''} width="full" />
    </div>
    <Input label="Where they came from" name="source" optional defaultValue={driver?.source ?? ''} maxLength={100} autoComplete="off" width="full" hint="For example a referral, job board or social media." />
    {leads && <Select label="Safety lead" name="safetyLeadId" defaultValue={driver ? driver.safetyLead?.id ?? '' : defaultLeadId ?? ''} placeholder="No Safety lead yet" width="full"
      options={leads.map(lead => ({ value: lead.id, label: lead.role === 'SAFETY_MANAGER' ? `${lead.name} (Safety manager)` : lead.name }))} hint="Who screens this driver." />}
    <Textarea label="Notes" name="notes" optional defaultValue={driver?.notes ?? ''} maxLength={2000} rows={3} hint="Only what helps the next call. Never SSNs, medical or drug test details." />
    <Notice message={error} error />
  </form>;
}
