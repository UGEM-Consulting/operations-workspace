'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Pencil, RotateCcw, UserCheck, UserMinus } from 'lucide-react';
import { PageCrumb } from '@/components/shell-context';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Notice } from '@/components/ui/alert';
import { DescriptionList } from '@/components/ui/description-list';
import { EmptyState } from '@/components/ui/feedback';
import { Select, Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Timeline } from '@/components/ui/timeline';
import { Badge } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { ApplicationCard } from './application-card';
import { DriverDocuments } from './driver-documents';
import { DriverForm, driverBody } from './driver-form';
import { CLOSED, documentLabels, driverBadge, driverTypes, fieldLabels, license, OWNABLE, WITHDRAWABLE, type DocumentKind, type DriverEventRow, type DriverProfile, type SafetyPeople, type SafetyPerson } from './types';

type Action = 'edit' | 'withdraw' | 'reopen' | 'owner';
const events: Record<string, string> = { CREATED: 'Added as a lead', UPDATED: 'Details updated', WITHDRAWN: 'Withdrawn', REOPENED: 'Reopened as a lead',
  SAFETY_LEAD_CHANGED: 'Safety lead changed', OWNER_ASSIGNED: 'Owner assigned', LINK_SENT: 'Application link created', LINK_CANCELLED: 'Application link cancelled',
  APPLICATION_VERIFIED: 'Driver opened their application', APPLICATION_SUBMITTED: 'Driver submitted their application', SSN_REVEALED: 'Full SSN viewed',
  DOCUMENT_UPLOADED: 'Driver scanned a document', DOCUMENT_VERIFIED: 'Document verified', DOCUMENT_VIEWED: 'Document opened' };
const who = (person: SafetyPerson | null) => person ? `${person.name}${person.active ? '' : ' (inactive)'}` : null;
function eventMeta(row: DriverEventRow) {
  const fields = row.event === 'UPDATED' && row.metadata.fields?.length ? ` · ${row.metadata.fields.map(field => fieldLabels[field] ?? field).join(', ')}` : '';
  // Steps the driver takes have no staff actor.
  const actor = row.actor ?? (['APPLICATION_VERIFIED', 'APPLICATION_SUBMITTED', 'DOCUMENT_UPLOADED'].includes(row.event) ? 'Driver' : 'Someone');
  return <>{actor} · <LocalTime iso={row.createdAt} />{fields}{row.metadata.emailChanged ? ' · email changed' : ''}{row.metadata.reopened ? ' · application reopened' : ''}{row.metadata.kind ? ` · ${documentLabels[row.metadata.kind as DocumentKind] ?? row.metadata.kind}` : ''}</>;
}

/**
 * One driver for the Safety department: contact and license details, who screens them (Safety lead) and who owns them
 * after approval (safety staff, with history), and what happened (field names only). `screener` is a Safety lead,
 * manager or administrator; `owns` is the safety staff member who currently owns the driver.
 */
export function DriverProfileView({ driver, people, screener, owns }: { driver: DriverProfile; people: SafetyPeople; screener: boolean; owns: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [action, setAction] = useState<Action | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const name = `${driver.firstName} ${driver.lastName}`.trim(), badge = driverBadge(driver.status), closed = CLOSED.includes(driver.status);
  const canEdit = !closed && (screener || owns), owner = driver.owners.find(row => row.endedAt === null) ?? null;
  function start(next: Action) { setAction(next); setError(''); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !action) return;
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    try {
      if (action === 'edit') await mutate(`safety/drivers/${driver.id}`, 'PATCH', { version: driver.version, ...driverBody(form) });
      else if (action === 'withdraw') await mutate(`safety/drivers/${driver.id}/withdraw`, 'POST', { version: driver.version, reason: form.get('reason') });
      else if (action === 'reopen') await mutate(`safety/drivers/${driver.id}/reopen`, 'POST', { version: driver.version });
      else await mutate(`safety/drivers/${driver.id}/owner`, 'POST', { version: driver.version, ownerId: form.get('ownerId'), ...(String(form.get('reason') ?? '').trim() ? { reason: form.get('reason') } : {}) });
      toast({ title: action === 'edit' ? 'Details saved' : action === 'withdraw' ? `${name} withdrawn` : action === 'reopen' ? `${name} reopened as a lead` : 'Owner assigned' });
      setAction(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  const titles: Record<Action, string> = { edit: `Edit ${name}`, withdraw: `Withdraw ${name}?`, reopen: `Reopen ${name} as a lead?`, owner: owner ? 'Change owner' : 'Assign owner' };
  const staff = people.staff.filter(person => person.id !== owner?.owner?.id);
  return <div className="space-y-6">
    <PageCrumb label={name} />
    <PageHeader title={name} badge={<Badge label={badge.label} tone={badge.tone} />}
      meta={[driverTypes[driver.driverType], driver.phone, <>Added <LocalTime iso={driver.createdAt} format="date" />{driver.addedBy ? ` by ${driver.addedBy.name}` : ''}</>]}
      action={<div className="flex flex-wrap gap-2">
        {screener && WITHDRAWABLE.includes(driver.status) && <Button variant="outline" onClick={() => start('withdraw')}><UserMinus aria-hidden="true" className="size-4" />Withdraw</Button>}
        {screener && driver.status === 'WITHDRAWN' && <Button variant="outline" onClick={() => start('reopen')}><RotateCcw aria-hidden="true" className="size-4" />Reopen as lead</Button>}
        {canEdit && <Button onClick={() => start('edit')}><Pencil aria-hidden="true" className="size-4" />Edit details</Button>}</div>} />
    {driver.status === 'WITHDRAWN' && <Alert tone="info" title="This driver was withdrawn">
      <p className="whitespace-pre-wrap">{driver.closedAt && <><LocalTime iso={driver.closedAt} format="date" />: </>}{driver.statusReason}</p>{screener && <p className="mt-1">Reopen them as a lead if they get back in touch.</p>}</Alert>}
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader title="Details" />
          <CardBody><DescriptionList items={[
            { label: 'First name', value: driver.firstName }, { label: 'Last name', value: driver.lastName },
            { label: 'Phone', value: driver.phone }, { label: 'Email', value: driver.email },
            { label: 'Driver type', value: driverTypes[driver.driverType] }, { label: 'License', value: license(driver), emptyLabel: 'Not known yet' },
            { label: 'Years driving', value: driver.experienceYears === null ? null : String(driver.experienceYears), emptyLabel: 'Not known yet' },
            { label: 'Where they came from', value: driver.source },
            { label: 'Notes', value: driver.notes ? <span className="whitespace-pre-wrap font-normal">{driver.notes}</span> : null, span: true, emptyLabel: 'No notes' }]} /></CardBody>
        </Card>
        {(driver.application !== undefined || driver.link !== undefined) && <ApplicationCard driver={driver} screener={screener} owns={owns} />}
        {driver.documents !== undefined && (driver.documents.length > 0 || driver.application) && <DriverDocuments driver={driver} canVerify={screener || owns} />}
        <Card>
          <CardHeader title="Activity" description="What changed and who did it." />
          <CardBody>{driver.activity.length ? <Timeline items={driver.activity.map(row => ({ id: row.id, title: events[row.event] ?? row.event, meta: eventMeta(row),
            tone: row.event === 'WITHDRAWN' ? 'neutral' : row.event === 'CREATED' ? 'info' : undefined }))} /> : <EmptyState compact title="Nothing yet" />}</CardBody>
        </Card>
      </div>
      <Card className="xl:sticky xl:top-20">
        <CardHeader title="Safety people" />
        <CardBody className="space-y-5">
          <DescriptionList layout="rows" items={[{ label: 'Safety lead', value: who(driver.safetyLead), emptyLabel: 'Not set' },
            { label: 'Owner', value: owner ? <>{who(owner.owner) ?? 'A former account'}<span className="block text-[13px] font-normal text-muted-foreground">Since <LocalTime iso={owner.startedAt} format="date" /></span></> : null,
              emptyLabel: OWNABLE.includes(driver.status) ? 'None yet' : 'Assigned after approval' }]} />
          {screener && OWNABLE.includes(driver.status) && <Button variant="outline" className="w-full" disabled={!staff.length} onClick={() => start('owner')}>
            <UserCheck aria-hidden="true" className="size-4" />{owner ? 'Change owner' : 'Assign owner'}</Button>}
          {driver.owners.length > 1 && <div>
            <p className="text-[13px] font-medium text-muted-foreground">Earlier owners</p>
            <ul className="mt-2 space-y-2 text-sm">{driver.owners.filter(row => row.endedAt !== null).map(row => <li key={row.id}>
              <span className="font-medium">{who(row.owner) ?? 'A former account'}</span>
              <span className="block text-[13px] text-muted-foreground"><LocalTime iso={row.startedAt} format="date" /> – <LocalTime iso={row.endedAt!} format="date" /></span>
            </li>)}</ul>
          </div>}
        </CardBody>
      </Card>
    </div>
    {action && <Dialog open onClose={() => setAction(null)} busy={pending} title={titles[action]} tone={action === 'withdraw' ? 'danger' : undefined}
      description={action === 'withdraw' ? 'The record is closed and kept. You can reopen it later.' : action === 'reopen' ? 'They start again as a lead.' : action === 'owner' ? 'The safety staff member who looks after this driver from now on.' : undefined}
      actions={<Button type="submit" form="driver-action" variant={action === 'withdraw' ? 'destructive' : 'default'}>{pending ? 'Saving…' : action === 'withdraw' ? 'Withdraw' : action === 'reopen' ? 'Reopen' : action === 'owner' ? 'Assign' : 'Save changes'}</Button>}>
      {action === 'edit' ? <DriverForm id="driver-action" driver={driver} leads={screener ? people.leads : undefined} onSubmit={submit} error={error} />
        : <form id="driver-action" onSubmit={submit} className="space-y-4">
          {action === 'withdraw' && <Textarea label="Why" name="reason" required maxLength={500} rows={3} hint="For example: no reply, took another job, didn’t meet requirements." />}
          {action === 'owner' && <>
            <Select label="Safety staff" name="ownerId" required placeholder="Choose a person" width="full" options={staff.map(person => ({ value: person.id, label: person.name }))} />
            {owner && <Textarea label="Why the owner is changing" name="reason" required maxLength={500} rows={3} />}
          </>}
          <Notice message={error} error />
        </form>}
    </Dialog>}
  </div>;
}
