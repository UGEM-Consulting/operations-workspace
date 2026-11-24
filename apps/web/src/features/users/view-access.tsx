'use client';
import { Alert } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/field';
import { chosenGrants, ownsDepartment, type ViewChoice, type ViewDepartment } from './view-grants';

/**
 * View-only access in the staff account dialog (section 39: ViewAccessGrantScreen, ViewOnlyAccountAddScreen; approved
 * 2026-11-20). Someone keeps their role and may also read Dispatch or Safety; View only is a role for someone with no job
 * in a department here. A second tick adds that department's photos and documents. The API checks every rule again.
 */
const SEES: Record<ViewDepartment, { summary: string; lines: string[] }> = {
  DISPATCH: { summary: 'Teams, dispatchers and the drivers they work with.', lines: ['Teams, dispatchers, supports and updaters: MC, team, job title, status and dates.', 'Work contacts: company email, RingCentral number and Telegram.', 'Their drivers, who helps them, load board accounts and History.'] },
  SAFETY: { summary: 'Drivers, units and expiring documents.', lines: ['Drivers: status, license, Safety Manager, unit and dispatcher.', 'Document dates, holds, clearance steps and yearly reviews.', 'Units and Expiring documents.'] },
};
const FILES: Record<ViewDepartment, { label: string; description: string }> = {
  DISPATCH: { label: 'Also photos and signed documents', description: 'Their ID photo, signed NDA, SOP and contact list, and paper scans. Each one opened is recorded. The profile photo shows either way.' },
  SAFETY: { label: 'Also document scans', description: 'License, medical card and work authorization scans, signed consent forms and unit papers. Each one opened is recorded. Never MVRs, PSP reports or test papers.' },
};

export function ViewAccessFields({ role, choice, onChange, name, mfaEnabled }: { role: string; choice: ViewChoice; onChange: (choice: ViewChoice) => void; name?: string; mfaEnabled?: boolean }) {
  if (role === 'SYSTEM_ADMIN') return null;
  const viewer = role === 'VIEWER', any = viewer || chosenGrants(role, choice).length > 0;
  const set = (department: ViewDepartment, next: Partial<{ on: boolean; files: boolean }>) => {
    const merged = { ...choice[department], ...next };
    onChange({ ...choice, [department]: { on: merged.on, files: merged.on && merged.files } });
  };
  return <>
    <fieldset className="grid min-w-0 gap-3">
      <legend className="mb-1 text-sm font-medium">{viewer ? 'Departments they can view' : 'Also view, read only'}</legend>
      <p className="-mt-2 text-[13px] leading-5 text-muted-foreground">{viewer ? 'Choose at least one. They change nothing anywhere.' : 'They can open these pages but change nothing there.'}</p>
      <div className={viewer ? 'grid gap-4 sm:grid-cols-2' : 'grid gap-3'}>
        {(['DISPATCH', 'SAFETY'] as const).map(department => ownsDepartment(role, department)
          ? <Checkbox key={department} label={department === 'DISPATCH' ? 'Dispatch' : 'Safety'} checked disabled readOnly description="Included in their role." />
          : <div key={department}>
            <Checkbox label={department === 'DISPATCH' ? 'Dispatch' : 'Safety'} checked={choice[department].on} onChange={event => set(department, { on: event.target.checked })}
              description={<>{viewer ? null : SEES[department].summary}<ul className="mt-1 list-disc space-y-0.5 pl-4">{SEES[department].lines.map(line => <li key={line}>{line}</li>)}</ul></>} />
            {choice[department].on && <div className="ml-7 mt-2 border-l-2 border-border py-1 pl-3">
              <Checkbox label={FILES[department].label} checked={choice[department].files} onChange={event => set(department, { files: event.target.checked })} description={FILES[department].description} />
            </div>}
          </div>)}
      </div>
    </fieldset>
    {any && <Alert tone="info" title="Never part of view-only access"><ul className="list-disc space-y-0.5 pl-4">
      <li>Personal email and phone, legal names, SSNs and application answers.</li>
      <li>ID photos, signed documents and scans, unless Also photos or Also document scans is ticked.</li>
      <li>MVRs, PSP reports and return-to-duty papers, whatever is ticked.</li>
      <li>Drug and alcohol test results, which stay with the Safety Director and the driver’s Safety Manager.</li>
      <li>Reasons and notes staff wrote, applications, IT tasks, exports and every change.</li></ul></Alert>}
    {any && <p className="text-[13px] leading-5 text-muted-foreground">Two-step verification is required for anyone who can view another department.
      {mfaEnabled ? ` ${name ?? 'They'} already use${name ? 's' : ''} it.` : ' They set it up when they next sign in.'}</p>}
  </>;
}
