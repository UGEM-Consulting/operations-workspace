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
import { Input, Select, Textarea } from '@/components/ui/field';
import { useToday } from './driver-documents';
import { LocalTime } from '@/components/ui/local-time';
import { Timeline } from '@/components/ui/timeline';
import { Badge, statusLabel } from '@/components/ui/status-badge';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { ApplicationCard } from './application-card';
import { ClearanceCard, ClearanceProgress } from './clearance-card';
import { AnnualReviewCard } from './annual-review-card';
import { TestingCard } from './testing-card';
import { IncidentsCard } from './incidents-card';
import { HistoryReview } from './history-review';
import { ConsentCard } from './consent-card';
import { DecisionCard } from './decision-card';
import { DriverDocuments } from './driver-documents';
import { DriverForm, driverBody } from './driver-form';
import { ScreeningCard } from './screening-card';
import { CLEARANCE_ITEMS, CLOSED, consentLabels, DECIDING, documentLabels, driverBadge, driverTypes, fieldLabels, license, OWNABLE, screeningChecks, WITHDRAWABLE, type DocumentKind, type DriverEventRow, type DriverProfile,
  type SafetyPeople, type SafetyPerson } from './types';

type Action = 'edit' | 'withdraw' | 'reopen' | 'owner' | 'left';
const events: Record<string, string> = { CREATED: 'Added as a lead', UPDATED: 'Details updated', WITHDRAWN: 'Withdrawn', LEFT: 'Marked as left', REOPENED: 'Reopened as a lead',
  SAFETY_LEAD_CHANGED: 'Safety lead changed', OWNER_ASSIGNED: 'Owner assigned', LINK_SENT: 'Application link created', LINK_CANCELLED: 'Application link cancelled',
  APPLICATION_VERIFIED: 'Driver opened their application', APPLICATION_SUBMITTED: 'Driver submitted their application', SSN_REVEALED: 'Full SSN viewed',
  DOCUMENT_UPLOADED: 'Driver scanned a document', DOCUMENT_VERIFIED: 'Document verified', DOCUMENT_VIEWED: 'Document opened',
  SCREENING_CHECKED: 'Screening check recorded', MVR_UPLOADED: 'MVR uploaded', MVR_VIEWED: 'MVR opened', CORRECTIONS_REQUESTED: 'Sent back to the driver for corrections',
  SENT_FOR_DECISION: 'Sent to the Safety manager', APPROVED: 'Approved', MORE_INFO_REQUESTED: 'Sent back to screening', PRE_ADVERSE_RECORDED: 'Pre-adverse notice recorded', REJECTED: 'Rejected', CONSENT_SIGNED: 'Driver signed a consent form',
  CLEARANCE_RECORDED: 'Clearance item recorded', EMPLOYER_RECORDED: 'Previous employer recorded', CLEARED: 'Cleared', DISPATCH_ASSIGNED: 'Assigned to a dispatcher' };
const employerActions: Record<string, string> = { 'from-application': 'added from the application', added: 'added', requested: 'asked', answered: 'answered', 'good-faith': 'good-faith effort recorded', updated: 'dates changed', removed: 'removed' };
const results: Record<string, string> = { PASS: 'passed', CONCERN: 'concern' };
const who = (person: SafetyPerson | null) => person ? `${person.name}${person.active ? '' : ' (inactive)'}` : null;
function eventMeta(row: DriverEventRow) {
  const fields = row.event === 'UPDATED' && row.metadata.fields?.length ? ` · ${row.metadata.fields.map(field => fieldLabels[field] ?? field).join(', ')}` : '';
  // Steps the driver takes have no staff actor.
  const actor = row.actor ?? (['APPLICATION_VERIFIED', 'APPLICATION_SUBMITTED', 'DOCUMENT_UPLOADED', 'CONSENT_SIGNED'].includes(row.event) ? 'Driver' : 'Someone');
  const check = row.metadata.check ? ` · ${screeningChecks.find(item => item.key === row.metadata.check)?.label ?? row.metadata.check}: ${row.metadata.result ? results[row.metadata.result] ?? statusLabel(row.metadata.result) : 'cleared'}` : '';
  return <>{actor} · <LocalTime iso={row.createdAt} />{fields}{row.metadata.emailChanged ? ' · email changed' : ''}{row.metadata.reopened ? ' · application reopened' : ''}{row.metadata.kind ? ` · ${documentLabels[row.metadata.kind as DocumentKind] ?? consentLabels[row.metadata.kind] ?? row.metadata.kind}` : ''}
    {check}{row.metadata.replaced ? ' · replaced the earlier one' : ''}{row.metadata.authorization === 'PAPER' ? ' · paper authorization on file' : ''}{row.metadata.conditional ? ' · with conditions' : ''}{row.metadata.concerns ? ` · ${row.metadata.concerns} ${row.metadata.concerns === 1 ? 'concern' : 'concerns'}` : ''}
    {row.metadata.item ? ` · ${CLEARANCE_ITEMS.find(item => item.key === row.metadata.item)?.label ?? row.metadata.item}: ${row.metadata.status ? statusLabel(row.metadata.status).toLowerCase() : 'not started'}` : ''}
    {row.metadata.action ? ` · ${employerActions[row.metadata.action] ?? row.metadata.action}` : ''}{row.event === 'DISPATCH_ASSIGNED' && row.metadata.first === false ? ' · changed' : ''}</>;
}

/**
 * One driver for the Safety department: contact and license details, who screens them (Safety lead) and who owns them
 * after approval (safety staff, with history), screening and the decision, and what happened (field names only).
 * `screener` is a Safety lead, manager or administrator; `decider` the Safety manager or an administrator; `owns` is the
 * safety staff member who currently owns the driver.
 */
export function DriverProfileView({ driver, people, screener, decider, owns }: { driver: DriverProfile; people: SafetyPeople; screener: boolean; decider: boolean; owns: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const today = useToday();
  const [action, setAction] = useState<Action | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const name = `${driver.firstName} ${driver.lastName}`.trim(), badge = driverBadge(driver.status), closed = CLOSED.includes(driver.status);
  const canEdit = !closed && (screener || owns), owner = driver.owners.find(row => row.endedAt === null) ?? null;
  // Clearance: the owner, the Safety manager and administrators, while the driver is approved (the API decides).
  const clearing = driver.status === 'APPROVED' || driver.status === 'CLEARED', canClear = driver.status === 'APPROVED' && (decider || owns);
  const conditions = clearing ? driver.screening?.reviews.find(row => row.action === 'APPROVED')?.conditions : null;
  const assignment = driver.assignments?.find(row => row.endedAt === null) ?? null;
  function start(next: Action) { setAction(next); setError(''); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !action) return;
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    try {
      if (action === 'edit') await mutate(`safety/drivers/${driver.id}`, 'PATCH', { version: driver.version, ...driverBody(form) });
      else if (action === 'withdraw') await mutate(`safety/drivers/${driver.id}/withdraw`, 'POST', { version: driver.version, reason: form.get('reason') });
      else if (action === 'left') await mutate(`safety/drivers/${driver.id}/left`, 'POST', { version: driver.version, leftOn: form.get('leftOn'), reason: form.get('reason') });
      else if (action === 'reopen') await mutate(`safety/drivers/${driver.id}/reopen`, 'POST', { version: driver.version });
      else await mutate(`safety/drivers/${driver.id}/owner`, 'POST', { version: driver.version, ownerId: form.get('ownerId'), ...(String(form.get('reason') ?? '').trim() ? { reason: form.get('reason') } : {}) });
      toast({ title: action === 'edit' ? 'Details saved' : action === 'withdraw' ? `${name} withdrawn` : action === 'left' ? `${name} marked as left` : action === 'reopen' ? `${name} reopened as a lead` : 'Owner assigned' });
      setAction(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  const titles: Record<Action, string> = { edit: `Edit ${name}`, withdraw: `Withdraw ${name}?`, reopen: `Reopen ${name} as a lead?`, owner: owner ? 'Change owner' : 'Assign owner', left: `Mark ${name} as left?` };
  const staff = people.staff.filter(person => person.id !== owner?.owner?.id);
  return <div className="space-y-6">
    <PageCrumb label={name} />
    <PageHeader title={name} badge={<Badge label={badge.label} tone={badge.tone} />}
      meta={[driverTypes[driver.driverType], driver.phone, <>Added <LocalTime iso={driver.createdAt} format="date" />{driver.addedBy ? ` by ${driver.addedBy.name}` : ''}</>]}
      action={<div className="flex flex-wrap gap-2">
        {screener && WITHDRAWABLE.includes(driver.status) && <Button variant="outline" onClick={() => start('withdraw')}><UserMinus aria-hidden="true" className="size-4" />Withdraw</Button>}
        {(driver.status === 'APPROVED' || driver.status === 'CLEARED') && (decider || owns) && <Button variant="outline" onClick={() => start('left')}><UserMinus aria-hidden="true" className="size-4" />Mark as left</Button>}
        {screener && driver.status === 'WITHDRAWN' && <Button variant="outline" onClick={() => start('reopen')}><RotateCcw aria-hidden="true" className="size-4" />Reopen as lead</Button>}
        {canEdit && <Button onClick={() => start('edit')}><Pencil aria-hidden="true" className="size-4" />Edit details</Button>}</div>} />
    {driver.status === 'WITHDRAWN' && <Alert tone="info" title="This driver was withdrawn">
      <p className="whitespace-pre-wrap">{driver.closedAt && <><LocalTime iso={driver.closedAt} format="date" />: </>}{driver.statusReason}</p>{screener && <p className="mt-1">Reopen them as a lead if they get back in touch.</p>}</Alert>}
    {driver.status === 'LEFT' && <Alert tone="info" title="This driver left">
      <p className="whitespace-pre-wrap">{driver.closedAt && <><LocalTime iso={driver.closedAt} format="date" />: </>}{driver.statusReason}</p></Alert>}
    {driver.status === 'REJECTED' && <Alert tone="info" title="This driver was rejected">
      <p>{driver.closedAt && <>Closed <LocalTime iso={driver.closedAt} format="date" /> after the final notice. </>}The record and the decisions are kept.</p></Alert>}
    {driver.status === 'APPLYING' && driver.application?.correctionNote && <Alert tone="warning" title="Back with the driver for corrections">
      <p className="whitespace-pre-wrap">{driver.application.correctionNote}</p>
      <p className="mt-1">They return to screening when they send the application again.</p></Alert>}
    {screener && driver.status === 'APPROVED' && !owner && people.staff.length > 0 && <Alert tone="info" title="Assign a safety staff owner"
      action={<Button size="sm" variant="outline" onClick={() => start('owner')}>Assign owner</Button>}>
      <p>The owner looks after this driver from now on, starting with the clearance checklist.</p></Alert>}
    {conditions && <Alert tone="info" title="Condition from the approval"><p className="whitespace-pre-wrap">{conditions}</p></Alert>}
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <div className="min-w-0 space-y-6">
        {/* While the driver is being cleared (and after), clearance is the work in hand, so it comes first. */}
        {driver.clearance && (clearing || driver.clearance.items.length > 0 || driver.clearance.employers.length > 0) && <ClearanceCard driver={driver} canWork={canClear} />}
        {driver.annualReviews && (driver.status === 'CLEARED' || driver.annualReviews.items.length > 0) && <AnnualReviewCard driver={driver} canRecord={driver.status === 'CLEARED' && (decider || owns)} />}
        {driver.testing && (driver.status === 'CLEARED' || driver.testing.items.length > 0) && <TestingCard driver={driver} canRecord={driver.status === 'CLEARED' && (decider || owns)} canVoid={decider} />}
        {driver.incidents && (driver.status === 'CLEARED' || driver.incidents.items.length > 0) && <IncidentsCard driver={driver} canRecord={driver.status === 'CLEARED' && (decider || owns)} canVoid={decider} />}
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
        {driver.screening && (DECIDING.includes(driver.status) || driver.screening.reviews.length > 0) && <DecisionCard driver={driver} decider={decider} />}
        {/* Kept while corrections are out too: the new link is shown once from this card after the driver leaves screening. */}
        {driver.screening && (driver.status === 'SCREENING' || driver.screening.checks.length > 0 || driver.screening.mvr || driver.application?.correctionNote) && <ScreeningCard driver={driver} screener={screener} />}
        {(driver.application !== undefined || driver.link !== undefined) && <ApplicationCard driver={driver} screener={screener} owns={owns} />}
        {driver.application?.status === 'SUBMITTED' && driver.application.history && <HistoryReview history={driver.application.history} sentOn={driver.application.submittedAt}
          currentAddress={[driver.application.fields.addressLine1, driver.application.fields.city, [driver.application.fields.state, driver.application.fields.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')} />}
        {driver.documents !== undefined && (driver.documents.length > 0 || driver.application) && <DriverDocuments driver={driver} canVerify={screener || owns} />}
        {driver.consents && (driver.consents.signatures.length > 0 || (driver.application && driver.consents.missing.length > 0)) && <ConsentCard driver={driver} />}
        <Card>
          <CardHeader title="Activity" description="What changed and who did it." />
          <CardBody>{driver.activity.length ? <Timeline items={driver.activity.map(row => ({ id: row.id, title: events[row.event] ?? row.event, meta: eventMeta(row),
            tone: row.event === 'WITHDRAWN' ? 'neutral' : row.event === 'CREATED' ? 'info' : undefined }))} /> : <EmptyState compact title="Nothing yet" />}</CardBody>
        </Card>
      </div>
      <div className="space-y-6 xl:sticky xl:top-20">
      {driver.clearance && clearing && <ClearanceProgress driver={driver} canWork={canClear} />}
      {driver.status === 'CLEARED' && driver.assignments && <Card>
        <CardHeader title="Dispatch" />
        <CardBody>{assignment ? <DescriptionList layout="rows" items={[{ label: 'MC', value: assignment.mc }, { label: 'Dispatcher', value: `${assignment.dispatcher}${assignment.team ? ` · ${assignment.team}` : ''}` },
          { label: 'Truck', value: assignment.truck, emptyLabel: 'No truck yet' }, { label: 'Since', value: <LocalTime iso={assignment.startedAt} format="date" /> }]} />
          : <p className="text-sm text-muted-foreground">Waiting for Dispatch to assign an MC and a dispatcher.</p>}</CardBody>
      </Card>}
      <Card>
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
    </div>
    {action && <Dialog open onClose={() => setAction(null)} busy={pending} title={titles[action]} tone={action === 'withdraw' || action === 'left' ? 'danger' : undefined}
      description={action === 'withdraw' ? 'The record is closed and kept. You can reopen it later.' : action === 'left' ? 'The record is closed and kept. Their owner and dispatch assignment end on the last day, and the dispatcher stops counting them.' : action === 'reopen' ? 'They start again as a lead.' : action === 'owner' ? 'The safety staff member who looks after this driver from now on.' : undefined}
      actions={<Button type="submit" form="driver-action" variant={action === 'withdraw' || action === 'left' ? 'destructive' : 'default'}>{pending ? 'Saving…' : action === 'withdraw' ? 'Withdraw' : action === 'left' ? 'Mark as left' : action === 'reopen' ? 'Reopen' : action === 'owner' ? 'Assign' : 'Save changes'}</Button>}>
      {action === 'edit' ? <DriverForm id="driver-action" driver={driver} leads={screener ? people.leads : undefined} onSubmit={submit} error={error} />
        : <form id="driver-action" onSubmit={submit} className="space-y-4">
          {action === 'withdraw' && <Textarea label="Why" name="reason" required maxLength={500} rows={3} hint="For example: no reply, took another job, didn’t meet requirements." />}
          {action === 'left' && <>
            <Input label="Last day they worked" name="leftOn" type="date" required width="sm" max={today ?? undefined} defaultValue={today ?? undefined} />
            <Textarea label="Why" name="reason" required maxLength={500} rows={3} hint="For example: resigned, contract ended. No health or other private details." />
          </>}
          {action === 'owner' && <>
            <Select label="Safety staff" name="ownerId" required placeholder="Choose a person" width="full" options={staff.map(person => ({ value: person.id, label: person.name }))} />
            {owner && <Textarea label="Why the owner is changing" name="reason" required maxLength={500} rows={3} />}
          </>}
          <Notice message={error} error />
        </form>}
    </Dialog>}
  </div>;
}
