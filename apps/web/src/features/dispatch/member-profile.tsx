'use client';
import Link from 'next/link';
import { phoneLabel } from '@/lib/phone';
import { MemberPhotosCard } from './member-photos';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ban, Building2, Calendar, CalendarClock, Ellipsis, FilePenLine, FileText, Link2, Mail, Monitor, Pencil, PenLine, Phone, Plus, RotateCcw, Route, Send, Undo2, UserCheck, UserMinus, UserPlus, Users, type LucideIcon } from 'lucide-react';
import { HistoryTimeline } from './history';
import { PageCrumb } from '@/components/shell-context';
import { Button } from '@/components/ui/button';
import { ViewDocumentButton } from '@/features/documents/document-modal';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { DropdownMenu, type MenuEntry } from '@/components/ui/dropdown-menu';
import { Alert, Notice } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { DescriptionList } from '@/components/ui/description-list';
import { Progress } from '@/components/ui/feedback';
import { Input, RadioGroup, Select, Textarea } from '@/components/ui/field';
import { EmailAfterFields } from '@/features/it/email-choice';
import { doneWord, emailAfterText, type EmailChoice } from '@/features/it/email-words';
import { LocalTime } from '@/components/ui/local-time';
import { PrivateImage } from '@/components/ui/private-image';
import { PhotoButton, type ViewablePhoto } from '@/features/documents/photo-modal';
import { Timeline } from '@/components/ui/timeline';
import { Badge, statusLabel } from '@/components/ui/status-badge';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { middayIso } from '@/lib/navigation';
import { paperScanItems } from './paper-scan';
import { ExistingAccountsCard, ExistingPaperworkCard, useCatchUpLink } from './paperwork';
import { askedFor, SupportItChoices, type SupportItItem } from './support-it';
import { signInItems } from './sign-in-status';
import { SignIn } from './sign-in';
import { ChangeCoversDialog, CoveredDriversCard, LeavingCoveredAlert } from './leave-covers';
import { HandOverChoice, usersOf } from './shared-accounts';
import { canCancelLeave, canPutOnLeave, Day, helperWords, LeaveAlert, LeaveCard, LeaveDialog, LeaveHistory, LeaveItCard, leaveBadge, shortDay, WorkingWithCard, type LeaveAction } from './leave';
import { Corrected, CorrectDetailsDialog, correctionItems } from './correct-details';
import { ChangeNameDialog, lastNameChange, NewNameQuestion, newNamePayload, newNameProblem, noNewName, type NewName } from './change-name';
import { AddedAsLeftAlert, canAskItToClose, CloseAccountsDialog, LeftDayDialog, lastDayMissing, NamesCard, NamesDialog } from './left-and-names';
import { itNotAsked, lastWorked, recordChangeItems } from './left-record';
import { awayPeriods, lastRehire, RehireDialog, RehiredAlert, rehiredMeta, UndoLeavingDialog, UndoWindowAlert } from './bring-back';
import { LoadBoardsCard, type LoadBoardAccount } from '@/features/load-boards/seats';
import { CompanyAccountsCard, MoveAccounts } from '@/features/company-accounts/card';
import { aSupport, assists, Choice, fullName, memberBadge, MemberProfile, supportName, TeamRow, toReassign, underMc } from './types';

const selfieUrl = (id: string) => `/api/backend/dispatch/members/${id}/photos/selfie`, idSelfieUrl = (id: string) => `/api/backend/dispatch/members/${id}/photos/id-selfie`;
const memberPhotos = (id: string, selfie: boolean, idSelfie: boolean, name: string): ViewablePhoto[] => [...(selfie ? [{ src: selfieUrl(id), title: `Selfie · ${name}`, alt: `Selfie of ${name}` }] : []), ...(idSelfie ? [{ src: idSelfieUrl(id), title: `Selfie holding an ID · ${name}`, meta: 'Check that the face and name match the ID.', alt: `Selfie of ${name} holding an ID` }] : [])];

type Action = 'place' | 'startDate' | 'supportType' | 'move' | 'reassign' | 'leave' | 'lastDay' | 'cancel' | 'removeNow' | 'title' | 'contact' | 'askIt';
// The Eastern date, as the API uses to tell a notice from leaving today; the browser's own date could promise the wrong one.
const today = (at = Date.now()) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
// Independent is a team choice under an MC (no team), never an MC (section 31): the team select's value for no team.
const NOTICE_MAX_DAYS = 90, INDEPENDENT = 'INDEPENDENT';
const noticeLimit = () => today(Date.now() + NOTICE_MAX_DAYS * 86400_000);
const LastDay = ({ day }: { day: string }) => <LocalTime iso={middayIso(day)} format="date" />;
// One reachable way to contact the dispatcher: where it came from, and a copy button.
/** " · also used by Drew Calloway" for an IT-recorded email or number others share (section 35). */
const alsoUsed = (users: { name: string }[]) => users.length ? ` · also used by ${users.map(user => user.name).join(', ')}` : '';
function ContactRow({ icon: Icon, value, source, action }: { icon: typeof Mail; value: string; source: string; action?: React.ReactNode }) {
  return <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
    <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{Icon === Phone ? phoneLabel(value) : value}</p><p className="text-[13px] text-muted-foreground">{source}</p></div>
    <span className="flex shrink-0 items-center gap-1"><CopyButton text={value} label="Copy" size="sm" variant="ghost" />{action}</span>
  </li>;
}

/**
 * One dispatcher (a record, no login), for every dispatch manager and administrator: the approved application details,
 * every way to reach them (company accounts, application contacts and ones staff added), signed documents, IT setup
 * progress, and where they work now and before. Moves and departures add history; nothing is overwritten.
 */
export function MemberProfileView({ member, mcs, teams, jobTitles, dispatchers = [], dispatchersFailed = false, admin = false, loadBoardAccounts = [] }: { member: MemberProfile; mcs: Choice[]; teams: TeamRow[]; jobTitles: Choice[]; loadBoardAccounts?: LoadBoardAccount[];
  dispatchers?: { id: string; name: string; mc: string | null; team: string | null }[]; dispatchersFailed?: boolean; admin?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [action, setAction] = useState<Action | null>(null);
  // What a manager asks IT to set up for a support or updater (SupportAskItScreen).
  const [itItems, setItItems] = useState<SupportItItem[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [mcId, setMcId] = useState(member.current?.mcId ?? '');
  // A move's company accounts (section 33): kept by default.
  const [moveAccounts, setMoveAccounts] = useState<'KEEP' | 'NEW'>('KEEP');
  const [kind, setKind] = useState<'EMAIL' | 'PHONE'>('PHONE');
  // What happens to their company email (section 40): Archive and forwarding to the manager to start.
  const [emailChoice, setEmailChoice] = useState<EmailChoice>({ action: 'ARCHIVE', forward: true });
  // Others using their email or number (section 35): handed over to the first of them unless the manager chooses to close them.
  const [handOverTo, setHandOverTo] = useState(member.sharing?.usedBy[0]?.users[0]?.id ?? '');
  const [lastDay, setLastDay] = useState(today());
  const [removing, setRemoving] = useState<{ id: string; value: string } | null>(null);
  const [assisting, setAssisting] = useState(member.supportOf?.wholeTeam ? 'TEAM' : 'DISPATCHER');
  // Leave (section 35) and an administrator's corrections (section 36) have their own dialogs.
  const [leaveAction, setLeaveAction] = useState<LeaveAction | null>(null), [correcting, setCorrecting] = useState(false);
  // People who left and other names (section 33) have their own dialogs.
  const [leftDialog, setLeftDialog] = useState<'names' | 'lastDay' | 'close' | 'record' | null>(null);
  // Bringing back someone who left (section 41).
  const [bringing, setBringing] = useState<'undo' | 'rehire' | null>(null);
  // Change name (section 45), and the new name a move or a change of who they assist may bring.
  const [naming, setNaming] = useState(false), [newName, setNewName] = useState<NewName>(noNewName), [target, setTarget] = useState('');
  const name = fullName(member), open = member.status !== 'LEFT', current = member.current, details = member.details, accounts = member.accounts, photos = memberPhotos(member.id, !!member.photo, !!member.idPhoto, name);
  const badge = memberBadge(member.status);
  // A support works where their dispatcher works and has no IT setup; their dispatcher changes instead of moving.
  const support = member.position === 'SUPPORT', supportOf = member.supportOf ?? null, called = supportName(member), otherType = member.supportType === 'UPDATER' ? 'SUPPORT' as const : 'UPDATER' as const, otherName = supportName({ supportType: otherType });
  const teamChoices = teams.filter(team => !team.archived && team.mc.id === mcId);
  // Section 45: a move to another MC asks whether they'll use a new name there; a support's change of who they assist offers it
  // when that someone works under another MC. The MC's name, or null when nothing is asked.
  const moveMc = current?.mcId && mcId && mcId !== current.mcId ? mcs.find(mc => mc.id === mcId)?.name ?? 'the new MC' : null;
  const nowMc = supportOf?.mc ?? null;
  const targetMc = assisting === 'TEAM' ? teams.find(team => team.id === target)?.mc.name ?? null : dispatchers.find(option => option.id === target)?.mc ?? null;
  const assistMc = support && nowMc && targetMc && targetMc !== nowMc ? targetMc : null;
  function start(next: Action) { setAction(next); setError(''); setNewName(noNewName); setTarget(''); setMcId(member.current?.mcId ?? ''); setLastDay(next === 'lastDay' && member.notice ? member.notice.lastDay : today()); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !action) return;
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setPending('form'); setError('');
    try {
      // A new name goes only when one was asked for, so an older API never sees the field otherwise (section 45).
      const nameProblem = action === 'move' && moveMc ? newNameProblem(newName, true, moveMc) : action === 'reassign' && assistMc ? newNameProblem(newName, false, assistMc) : '';
      if (nameProblem) { setError(nameProblem); setPending(null); return; }
      const named = (action === 'move' && moveMc) || (action === 'reassign' && assistMc) ? newNamePayload(newName) : {};
      if (action === 'reassign') await mutate(`dispatch/members/${member.id}/reassign`, 'POST', { version: member.version, ...(assisting === 'TEAM' ? { teamId: form.teamId } : { dispatcherId: form.dispatcherId }), startedAt: form.startedAt, reason: form.reason, ...named });
      else if (action === 'supportType') await mutate(`dispatch/members/${member.id}/support-type`, 'POST', { version: member.version, supportType: otherType });
      else if (action === 'place') await mutate(`dispatch/members/${member.id}/place`, 'POST', { version: member.version, mcId: form.mcId, teamId: form.teamId === INDEPENDENT ? null : form.teamId || null, ...(form.startedAt ? { startedAt: form.startedAt } : {}) });
      else if (action === 'startDate') await mutate(`dispatch/members/${member.id}/start-date`, 'POST', { version: member.version, startedOn: form.startedOn, ...(form.reason?.trim() ? { reason: form.reason } : {}) });
      // Their company accounts (section 33): sent only when IT is asked for new ones, so an older API never sees the field otherwise.
      else if (action === 'move') await mutate(`dispatch/members/${member.id}/move`, 'POST', { version: member.version, mcId: form.mcId, teamId: form.teamId === INDEPENDENT ? null : form.teamId || null, startedAt: form.startedAt, reason: form.reason, ...named,
        ...(moveAccounts === 'NEW' && mcId !== current?.mcId ? { accounts: 'NEW', closeKept: form.closeKept === 'on', ...(form.emailAction ? { emailAction: form.emailAction } : {}) } : {}) });
      // The email choice goes only when IT has accounts to remove, so an older API never sees it otherwise.
      else if (action === 'leave') await mutate(`dispatch/members/${member.id}/leave`, 'POST', { version: member.version, leftAt: form.leftAt, reason: form.reason, ...(removesAccess && (accounts?.companyEmail || member.existing?.companyEmail) && !(handOverTo && member.sharing?.usedBy.some(item => item.kind === 'EMAIL')) ? { emailAfter: emailChoice.forward ? 'FORWARD' : 'SUSPEND', emailAction: emailChoice.action } : {}), ...(handOverTo && member.sharing?.usedBy.length ? { handOverTo } : {}) });
      else if (action === 'lastDay') await mutate(`dispatch/members/${member.id}/last-day`, 'POST', { version: member.version, lastDay: form.lastDay, reason: form.reason });
      else if (action === 'cancel') await mutate(`dispatch/members/${member.id}/cancel-notice`, 'POST', { version: member.version, reason: form.reason });
      else if (action === 'removeNow') await mutate(`dispatch/members/${member.id}/remove-access`, 'POST', { version: member.version, reason: form.reason });
      else if (action === 'askIt') {
        if (!itItems.length) { setError('Choose what IT should set up.'); setPending(null); return; }
        await mutate(`dispatch/members/${member.id}/it-setup`, 'POST', { items: itItems, ...(form.note?.trim() ? { note: form.note } : {}) });
      }
      else if (action === 'title') await mutate(`dispatch/members/${member.id}`, 'PATCH', { version: member.version, jobTitleId: form.jobTitleId || null });
      else await mutate(`dispatch/members/${member.id}/contacts`, 'POST', { kind, value: form.value, ...(form.label?.trim() ? { label: form.label } : {}) });
      toast({ title: action === 'supportType' ? `${name} is now ${aSupport({ supportType: otherType })}` : action === 'place' ? 'MC and team saved' : action === 'startDate' ? 'Start date saved' : action === 'reassign' ? 'Who they assist changed' : action === 'move' ? `${name} moved` : action === 'leave' ? (lastDay > today() ? `Notice recorded for ${name}` : `${name} marked as left`) : action === 'lastDay' ? 'Last day changed' : action === 'cancel' ? 'Notice cancelled' : action === 'removeNow' ? 'IT was asked to remove access now' : action === 'title' ? 'Job title updated' : action === 'askIt' ? 'Sent to IT' : kind === 'EMAIL' ? 'Email added' : 'Phone number added' });
      setAction(null); router.refresh();
    } catch (error) { setError(errorMessage(error, 'Unable to save. Your entries have been kept.')); }
    finally { setPending(null); }
  }
  async function removeContact(id: string) {
    if (pending) return;
    setPending(id);
    try { await mutate(`dispatch/members/${member.id}/contacts/${id}/remove`, 'POST', {}); setRemoving(null); toast({ title: 'Contact removed' }); router.refresh(); }
    catch (error) { setRemoving(null); toast({ tone: 'danger', title: 'Not removed', description: errorMessage(error, 'Reload the page and try again.') }); }
    finally { setPending(null); }
  }
  // "Personal email · corrected by Morgan Ellis on Nov 11, 2026", or where it came from.
  const correctedSource = (field: string, label: string) => { const corrected = member.correctedFields?.[field];
    return corrected ? `${label} · corrected by ${corrected.by} on ${new Date(corrected.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}` : `${label} (from their application)`; };
  // Under an MC with no team is Independent; no MC at all predates that and reads as no MC yet.
  const where = (row: { mc: string | null; team: string | null }) => row.mc ? `${row.mc} · ${row.team ?? 'Independent'}` : 'No MC yet';
  const progress = accounts?.total ? <Progress label="IT setup" value={accounts.done ?? 0} max={accounts.total} /> : null;
  // Someone with IT setup (finished or not) gets an IT removal checklist when marked as left; supports never had accounts.
  const existing = member.existing ?? null;
  // Added with details missing: no MC yet, and the day they were added never shown as their start date.
  const noMc = !!existing && !support && !current && !member.history.length, startKnown = existing?.startDateKnown !== false, undated = existing?.undatedPeriodId ?? null;
  const when = (row: { id: string; startedAt: string }) => row.id === undated ? 'Started on a date not recorded' : <LocalTime iso={row.startedAt} format="date" />;
  const startAction = { label: startKnown ? 'Correct start date' : 'Add start date', icon: Calendar, onSelect: () => start('startDate') };
  // Added by hand: a dispatcher always gets a checklist, a support only when accounts were recorded for them.
  const recordedAccounts = existing && (!support || existing.companyEmail || existing.ringCentralNumber || existing.datEmail || existing.truckstopEmail) ? { companyEmail: existing.companyEmail, ringCentralNumber: existing.ringCentralNumber } : null;
  // With seats (section 33) the Load boards card shows the sign-ins, so the IT setup card doesn't repeat them.
  const signIns = member.loadBoardSeats ? { dat: null, truckstop: null } : { dat: accounts?.datEmail ?? existing?.datEmail ?? null, truckstop: accounts?.truckstopEmail ?? existing?.truckstopEmail ?? null }, telegram = details?.telegram ? null : existing?.telegram ?? null;
  const removesAccess = !!accounts || !!recordedAccounts, removal = member.removal ?? null;
  // The recorded extension belongs to the recorded number: never shown beside a different number IT assigned.
  const digits = (value: string | null | undefined) => value?.replace(/\D/g, '') ?? '';
  const extension = accounts?.ringCentralExtension ?? (!accounts?.workPhone || digits(accounts.workPhone) === digits(existing?.ringCentralNumber) ? existing?.ringCentralExtension ?? null : null);
  // A support's or updater's IT setup (section 32): offered once the API knows it (itSetup), never while one is open or they're leaving.
  const itSetup = member.itSetup ?? null, itOpen = itSetup?.open ?? null;
  const removalOpen = !!removal && !removal.completedAt, notice = member.notice ?? null, onNotice = open && !!notice;
  const drivers = member.driversToReassign ?? [], supportsLeft = member.supports ?? [], reassign = toReassign(drivers.length, supportsLeft.length), anyoneLeft = drivers.length + supportsLeft.length > 0;
  const noticeDay = lastDay > today();
  const leave = open ? member.leave ?? null : null, away = !!leave?.started;
  // One main button, the next thing this record needs; everything else waits in More actions, with what ends things last.
  const catchUp = useCatchUpLink(member), needsLink = !!existing && !existing.acceptedAt && !!existing.personalEmail && !existing.catchUp?.started;
  const actions: Record<'lastDay' | 'reassign' | 'place' | 'link' | 'move' | 'return', { label: string; icon: LucideIcon; onClick: () => void; outline?: boolean }> = {
    return: { label: 'Record return', icon: UserCheck, onClick: () => setLeaveAction('return') },
    lastDay: { label: 'Change last day', icon: Calendar, outline: true, onClick: () => start('lastDay') }, reassign: { label: 'Change who they assist', icon: Route, onClick: () => start('reassign') },
    place: { label: 'Set MC and team', icon: Route, onClick: () => start('place') }, link: { label: catchUp.label, icon: Link2, onClick: catchUp.create }, move: { label: current && !current.mc ? 'Set MC and team' : 'Move to another MC or team', icon: Route, onClick: () => start('move') } };
  // Someone away has one next step: their return. A dispatcher on leave isn't moved until then.
  const mainKey = onNotice ? 'lastDay' : away ? 'return' : support ? 'reassign' : noMc ? 'place' : needsLink ? 'link' : 'move', main = actions[mainKey];
  const others = [...(needsLink ? ['link' as const] : []), ...(support ? ['reassign' as const] : noMc ? ['place' as const] : !onNotice && !away ? ['move' as const] : [])].filter(key => key !== mainKey);
  const leaveItems: MenuEntry[] = leave ? [{ label: 'Change return date', icon: Calendar, onSelect: () => setLeaveAction('backOn') },
    ...(leave.covers?.length || leave.uncovered?.length ? [{ label: 'Change who covers', icon: Route, onSelect: () => setLeaveAction('covers') }] : []), { label: 'Edit leave reason', icon: Pencil, onSelect: () => setLeaveAction('leaveReason') },
    ...(canCancelLeave(leave) ? [{ label: 'Cancel leave', icon: RotateCcw, onSelect: () => setLeaveAction('cancelLeave') }] : [])] : canPutOnLeave(member) ? [{ label: 'Put on leave', icon: CalendarClock, onSelect: () => setLeaveAction('putOnLeave') }] : [];
  const correctItem: MenuEntry[] = [...(open ? [{ label: 'Change name', icon: PenLine, onSelect: () => setNaming(true) }] : []), ...(admin && open && details ? [{ label: 'Correct details', icon: FilePenLine, onSelect: () => setCorrecting(true) }] : []), { label: 'Edit names', icon: Pencil, onSelect: () => setLeftDialog('names') }];
  const leftMeta = lastDayMissing(member) ? 'Left, last day not recorded' : member.leftAt ? <>Left <LocalTime iso={member.leftAt} format="date" /></> : null;
  // Someone who left shows what was: their MC and team history on Overview, ending with the day they left, and no Now card.
  const gone = member.status === 'LEFT', addedLeft = gone && !!existing?.addedAsLeft;
  // Someone who left: the record can't be moved, but a missing last day, their names and (once) closing their accounts still can.
  // Undo leaving waits in More actions for 30 days after the last day; Rehire is the main button (LeftBringBackScreen). An older API offers neither.
  // The name before their latest new name (NameChangedProfileScreen); a fixed mistake isn't shown.
  const lastChange = lastNameChange(member), wasName = lastChange?.kind === 'NEW_NAME' && lastChange.was !== name ? lastChange.was : null;
  const bringBack = gone ? member.bringBack ?? null : null, rehired = lastRehire(member);
  // An undone leaving's checklist restores what IT removed; they're already Active, so the IT card says so.
  const latestReturn = member.returns?.[0], restoring = latestReturn?.kind === 'UNDO' && !!latestReturn.setup && !latestReturn.setup.completedAt && !latestReturn.setup.cancelledAt;
  const leftMenu: MenuEntry[] = [...(bringBack?.canUndo ? [{ label: 'Undo leaving', icon: Undo2, onSelect: () => setBringing('undo') }] : []), ...(existing ? [{ label: 'Edit recorded details', icon: FilePenLine, onSelect: () => setLeftDialog('record') }] : []), { label: 'Edit names', icon: Pencil, onSelect: () => setLeftDialog('names') }, ...(canAskItToClose(member) ? [{ separator: true as const }, { label: 'Ask IT to close their accounts', icon: Monitor, onSelect: () => setLeftDialog('close') }] : [])];
  const leftActions = <div className="flex flex-wrap items-center gap-2 max-sm:w-full">{lastDayMissing(member) && <Button className="max-sm:flex-1" onClick={() => setLeftDialog('lastDay')}><Calendar aria-hidden="true" className="size-4" />Add last day</Button>}
    {bringBack && <Button className="max-sm:flex-1" variant={lastDayMissing(member) ? 'outline' : 'default'} onClick={() => setBringing('rehire')}><UserPlus aria-hidden="true" className="size-4" />Rehire</Button>}<DropdownMenu label="More actions" triggerIcon={Ellipsis} align="end" items={leftMenu} /></div>;
  const ending = onNotice ? [{ label: 'Cancel notice', icon: RotateCcw, onSelect: () => start('cancel') }, ...(removalOpen && !removal?.removeNowAt ? [{ label: 'Remove access now', icon: Ban, danger: true, onSelect: () => start('removeNow') }] : [])]
    : [{ label: 'Mark as leaving', icon: UserMinus, danger: true, onSelect: () => start('leave') }];
  const otherItems: MenuEntry[] = others.map(key => ({ label: actions[key].label, icon: actions[key].icon, onSelect: actions[key].onClick }));
  // On leave (OnLeaveProfileScreen, OnLeaveUpdaterScreen): the return date first, then the rest, with what ends things last.
  const more: MenuEntry[] = leave ? [leaveItems[0], ...otherItems, ...leaveItems.slice(1), ...correctItem, ...(existing ? [startAction] : []), { separator: true as const }, ...ending] : [...correctItem, ...otherItems, ...(support && itSetup && open && !onNotice && !leave ? [{ label: itOpen ? 'Ask IT to set up (IT is still working on the last request)' : 'Ask IT to set up', icon: Monitor, disabled: !!itOpen, onSelect: () => { setItItems([]); start('askIt'); } }] : []),
    ...(support ? [{ label: `Change to ${otherName}`, icon: Users, onSelect: () => start('supportType') }] : []), ...(existing ? [startAction] : []), ...leaveItems, ...(others.length || existing || support || leaveItems.length || correctItem.length ? [{ separator: true as const }] : []), ...ending];
  const mcHistory = !support && <Card>
    <CardHeader title="MC and team history" description={gone ? undefined : 'Every MC and team this dispatcher has worked for. Moves are recorded, never overwritten.'} />
    <CardBody>{noMc && !gone && <p className="text-sm text-muted-foreground">No MC yet. {member.firstName} can’t be given drivers or lead a team until they have one.</p>}<Timeline items={[
      ...(gone ? [{ id: 'left', tone: 'neutral' as const, icon: <UserMinus aria-hidden="true" />, title: 'Left', meta: lastDayMissing(member) ? 'Day not recorded' : member.leftAt ? <LocalTime iso={member.leftAt} format="date" /> : undefined }] : []),
      ...member.history.flatMap((row, index) => [{ id: row.id, tone: row.endedAt ? 'neutral' as const : 'success' as const,
      icon: index < member.history.length - 1 && member.history[index + 1].mcId === row.mcId ? <Users aria-hidden="true" /> : <Building2 aria-hidden="true" />,
      // The period of someone added as Left with no last day ends on a day that isn't recorded.
      title: where(row), meta: <>{when(row)} – {row.endedAt ? (index === 0 && lastDayMissing(member) ? 'last day' : <LocalTime iso={row.endedAt} format="date" />) : 'today'}{row.movedBy ? ` · by ${row.movedBy}` : ''}</>,
      body: row.reason ?? undefined },
      // The time away between two stays (section 41), under the period they came back to.
      ...awayPeriods(member).filter(away => row.startedAt.slice(0, 10) === away.firstDay).map(away => ({ id: away.id, tone: 'neutral' as const, icon: <UserMinus aria-hidden="true" />, title: 'Away',
        meta: <>{away.leftKnown ? <LocalTime iso={new Date(Date.parse(away.leftAt) + 86400_000).toISOString()} format="date" /> : 'After a day not recorded'} – <LocalTime iso={new Date(Date.parse(`${away.firstDay}T12:00:00Z`) - 86400_000).toISOString()} format="date" /></> }))])]} />{gone && !member.history.length && <p className="text-sm text-muted-foreground">No MC or team was recorded.</p>}</CardBody>
  </Card>;
  // Handed over to someone staying: kept open for them, so nothing was archived or turned off.
  const keptFor = `kept for ${removal?.handedOverTo ?? 'the person staying'}`;
  const emailNow = removal?.emailHandedOver ? keptFor : removal?.tasks.find(task => task.key === 'GOOGLE_WORKSPACE')?.status === 'COMPLETED'
    ? `${removal.emailDone ? doneWord(removal.emailDone).toLowerCase() : 'suspended'}${removal.emailAfter === 'FORWARD' ? ` and forwarded to ${removal.forwardTo ?? 'the manager'} for 30 days` : ''}` : null;
  return <div className="space-y-6">
    <PageCrumb label={name} />
    <div className="flex flex-wrap items-start gap-4">
      {member.photo ? <PhotoButton photos={photos} src={selfieUrl(member.id)} label={`Open the profile photo of ${name}`} className="shrink-0 rounded-lg">
        <PrivateImage src={selfieUrl(member.id)} alt={`Profile photo of ${name}`} className="size-24 rounded-lg border object-cover sm:size-28" /></PhotoButton> : <Avatar name={name} size="lg" />}
      <div className="min-w-0 flex-1"><PageHeader title={name} badge={<span className="flex flex-wrap gap-2">{!away && <Badge label={badge.label} tone={badge.tone} />}{leave && <Badge {...leaveBadge(leave)} />}{existing && <Badge label="Added by hand" tone="neutral" />}{notice && <Badge label={notice.passed ? 'Last day passed' : `Leaving ${new Date(middayIso(notice.lastDay)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`} tone={notice.passed ? 'danger' : 'warning'} />}</span>}
        meta={[support ? (supportOf ? <>{called} for {assists(supportOf)} · {supportOf.wholeTeam ? supportOf.mc : where(supportOf)}</> : leftMeta ? leftMeta : 'No dispatcher')
          : current ? (current.id === undated || !current.mc ? where(current) : <>{where(current)} since <LocalTime iso={current.startedAt} format="date" /></>) : leftMeta ? leftMeta : noMc ? 'No MC yet' : 'No MC or team',
          ...(rehired && !notice && !leave ? rehiredMeta(member).slice(1) : []),
          ...(wasName ? [`Was ${wasName}`] : []),
          ...(support ? [] : [member.leadOf ? `Team lead of ${member.leadOf.name}` : addedLeft ? lastWorked(member) : member.jobTitle?.name ?? 'Dispatcher']),
          notice ? <>Last day <LastDay day={notice.lastDay} /></> : leave ? <>Away {shortDay(leave.firstDay)} to <Day day={leave.backOn} /></> : rehired ? rehiredMeta(member)[0] : existing ? (startKnown ? <>Started <LocalTime iso={member.joinedAt} format="date" /></> : 'Start date not recorded') : <>Approved <LocalTime iso={member.joinedAt} format="date" /></>]}
        action={open ? <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
          <Button className="max-sm:flex-1" variant={main.outline ? 'outline' : 'default'} disabled={catchUp.busy && mainKey === 'link'} onClick={main.onClick}><main.icon aria-hidden="true" className="size-4" />{main.label}</Button>
          {more.length > 0 && <DropdownMenu label="More actions" triggerIcon={Ellipsis} align="end" items={more} />}
          {catchUp.result}</div> : leftActions} /></div>
    </div>
    {notice && (notice.passed ? <Alert tone="danger" title="Their last day has passed"><p>{anyoneLeft ? `${reassign} still assigned, so this record stays Leaving until they’re reassigned, then it becomes Left automatically. ` : 'They’ll be marked as left within a few minutes. '}IT’s removal of their access doesn’t wait for this.</p></Alert>
      : anyoneLeft ? <Alert tone="warning" title={<>{reassign} to reassign by <LastDay day={notice.lastDay} /></>}><p>{name} can’t be marked as left while anyone is still with them. IT removes their access at the end of that day either way.</p></Alert>
      : <Alert tone="info" title={<>Leaving <LastDay day={notice.lastDay} /></>}><p>Everyone is reassigned. The workspace marks them as left once that day has passed.</p></Alert>)}
    {leave && <LeaveAlert member={member} leave={leave} />}
    {member.previousRecord && <Alert tone="info" title="Worked here before"><p>{member.firstName} came back after leaving. Their earlier record: <Link href={`/dispatch/dispatchers/${member.previousRecord.id}`} className="text-primary underline-offset-4 hover:underline">{member.previousRecord.name}</Link>{member.previousRecord.leftAt ? <>, left <LocalTime iso={member.previousRecord.leftAt} format="date" /></> : null}.</p></Alert>}
    {member.laterRecord && <Alert tone="info" title="Came back later"><p>{member.firstName} returned and has a newer record: <Link href={`/dispatch/dispatchers/${member.laterRecord.id}`} className="text-primary underline-offset-4 hover:underline">{member.laterRecord.name}</Link>, from <LocalTime iso={member.laterRecord.joinedAt} format="date" />.</p></Alert>}
    {open && member.signIn?.status === 'WAITING' && member.signIn.request !== 'TURN_OFF' && <Alert tone="info" title={`IT will ${member.signIn.request === 'TURN_ON' ? 'turn' : 'create'} ${member.firstName}’s sign-in${member.signIn.request === 'TURN_ON' ? ' back on' : ''}`}>
      <p>{accounts?.companyEmail ?? existing?.companyEmail ? `They’ll use ${accounts?.companyEmail ?? existing?.companyEmail} and send ${member.firstName} a first password.` : 'IT will add their company email first, then send them a first password.'} You don’t need to do anything.</p></Alert>}
    {open && member.signInOff && member.signIn?.status !== 'WAITING' && !notice?.passed && !removal?.removeNowAt && <Alert tone="warning" title="Their team lead sign-in is off"><p>If they’re still working as a team lead, an administrator can turn it back on in Staff accounts.</p></Alert>}
    <RehiredAlert member={member} />
    {member.status === 'ONBOARDING' && !rehired && <Alert tone="info" title="Waiting for IT setup"><p>This dispatcher becomes Active when IT finishes their company accounts{accounts?.total ? ` (${accounts.done} of ${accounts.total} tasks done)` : ''}.</p></Alert>}
    {gone && <UndoWindowAlert member={member} />}
    {member.status === 'LEFT' && (removal && removalOpen ? <Alert tone="warning" title={`IT is removing access: ${removal.done} of ${removal.total} done`}>
      <p>{emailNow ? `Company email ${emailNow}. ` : ''}The record and its history are kept; it can’t be moved or edited.</p></Alert>
      : existing?.addedAsLeft && !removal ? <AddedAsLeftAlert member={member} /> : <Alert tone="info" title="This dispatcher has left"><p>{removal?.completedAt ? <>IT removed their access <LocalTime iso={removal.completedAt} format="date" />. </> : null}The record and its history are kept. It can’t be moved or edited.</p></Alert>)}
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <div className="min-w-0">
        <Tabs label="Dispatcher sections" defaultValue="overview" items={[{ key: 'overview', label: 'Overview' }, { key: 'files', label: 'Photos and documents', count: (member.photo ? 1 : 0) + (member.idPhoto ? 1 : 0) + (member.documents?.length ?? 0) }, { key: 'history', label: 'History' }]}
          panels={{
            overview: <div className="space-y-6">
            {leave && <LeaveCard leave={leave} />}
            {leave && <CoveredDriversCard member={member} leave={leave} />}
            {leave && <WorkingWithCard member={member} />}
            {notice && anyoneLeft && <Card><CardHeader title="Still to reassign" description="Move each one to another dispatcher before the last day." />
              <ul className="mt-3 divide-y divide-border border-t border-border">
                {drivers.map(driver => <li key={driver.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"><span className="min-w-0"><span className="block text-sm font-medium">{driver.name}</span><span className="text-[13px] text-muted-foreground">Driver{driver.truck ? ` · truck ${driver.truck}` : ''}</span></span>
                  <Button asChild size="sm" variant="outline"><Link href="/dispatch/drivers?status=ASSIGNED">Change dispatcher<span className="sr-only"> for {driver.name}</span></Link></Button></li>)}
                {supportsLeft.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"><span className="min-w-0"><span className="block text-sm font-medium">{row.name}</span><span className="text-[13px] text-muted-foreground">{supportName(row)}</span></span>
                  <Button asChild size="sm" variant="outline"><Link href={`/dispatch/dispatchers/${row.id}`}>Reassign<span className="sr-only"> {row.name}</span></Link></Button></li>)}
              </ul></Card>}
            {notice && <Card><CardHeader title="Why they’re leaving" /><CardBody className="space-y-1"><p className="whitespace-pre-wrap text-sm">{notice.reason}</p>
              <p className="text-[13px] text-muted-foreground">Notice recorded{notice.recordedBy ? ` by ${notice.recordedBy}` : ''} on <LocalTime iso={notice.createdAt} format="date" />.</p>
              {removal?.removeNowAt && <p className="pt-2 text-sm"><span className="font-medium">Access removal requested <LocalTime iso={removal.removeNowAt} format="date" />:</span> {removal.removeNowReason}</p>}</CardBody></Card>}
            {member.status === 'LEFT' && member.leftReason && <Card><CardHeader title="Why they left" />
              <CardBody className="space-y-1"><p className="whitespace-pre-wrap text-sm">{member.leftReason}</p>
                {existing?.addedAsLeft ? <p className="text-[13px] text-muted-foreground">From {existing.sourceName ? 'the file' : 'their record'}, added by {existing.addedBy} on <LocalTime iso={existing.createdAt} format="date" />.</p>
                  : (member.leftBy || member.leftAt) && <p className="text-[13px] text-muted-foreground">Marked as left{member.leftBy ? ` by ${member.leftBy}` : ''}{member.leftAt ? <> on <LocalTime iso={member.leftAt} format="date" /></> : null}.</p>}</CardBody></Card>}
            {/* Load boards (section 33): an administrator adds and changes seats here; IT does it from each account's page. */}
            {member.loadBoardSeats && <LoadBoardsCard memberId={member.id} name={name} seats={member.loadBoardSeats} seatEmails={member.seatEmails} accounts={loadBoardAccounts} canChange={admin && !gone}
              companyEmails={[...new Set([accounts?.companyEmail, existing?.companyEmail].filter((email): email is string => !!email))]} />}
            <NamesCard member={member} onEdit={() => setLeftDialog('names')} onChangeName={open ? () => setNaming(true) : undefined} />
            {gone && mcHistory}
            {/* Someone added as Left never had paperwork to do here. */}
            {existing && !addedLeft && <ExistingPaperworkCard member={member} />}
            {details && <Card>
              <CardHeader title="Personal details" description={<>From the approved application{details.submittedAt ? <>, last submitted <LocalTime iso={details.submittedAt} format="date" /></> : null}.</>} />
              <CardBody><DescriptionList items={[
                // Legal and American name as one row each (CorrectedProfileScreen), with who corrected either part.
                ...([['Legal name', 'legalFirstName', 'legalLastName'], ['American name', 'preferredAmericanFirstName', 'preferredAmericanLastName']] as const).map(([label, first, last]) =>
                  ({ label, value: (details[first] || details[last]) && <>{[details[first], details[last]].filter(Boolean).join(' ')}<Corrected member={member} field={member.correctedFields?.[first] ? first : last} /></> })),
                { label: 'Telegram', value: details.telegram ? <>@{details.telegram.replace(/^@/, '')}<Corrected member={member} field="telegram" /></> : null },
                ...(support || existing ? [] : [{ label: 'Employment on the application', value: [details.jobTitle, details.mcName, details.teamLead].filter(Boolean).join(' · ') || null }])]} /></CardBody>
            </Card>}
                <Card>
              <CardHeader title="Contacts" description="Every way to reach this dispatcher." actions={open && <Button size="sm" variant="outline" onClick={() => start('contact')}><Plus aria-hidden="true" className="size-4" />Add email or phone</Button>} />
              <ul className="mt-3 divide-y divide-border border-t border-border">
                {accounts?.companyEmail && <ContactRow icon={Mail} value={accounts.companyEmail} source={`Company email (IT)${alsoUsed(usersOf(member, 'EMAIL', accounts.companyEmail))}`} />}
                {accounts?.workPhone && <ContactRow icon={Phone} value={accounts.workPhone} source={`Work phone, RingCentral (IT)${alsoUsed(usersOf(member, 'RINGCENTRAL', accounts.workPhone))}`} />}
                {existing?.personalEmail && existing.personalEmail !== details?.personalEmail && <ContactRow icon={Mail} value={existing.personalEmail} source="Personal email (recorded by a manager)" />}
                {existing?.personalPhone && existing.personalPhone !== details?.personalPhoneNumber && <ContactRow icon={Phone} value={existing.personalPhone} source="Personal phone (recorded by a manager)" />}
                {telegram && <ContactRow icon={Send} value={`@${telegram}`} source="Telegram (recorded by a manager)" />}
                {details?.personalEmail && <ContactRow icon={Mail} value={details.personalEmail} source={correctedSource('personalEmail', 'Personal email')} />}
                {details?.personalPhoneNumber && <ContactRow icon={Phone} value={details.personalPhoneNumber} source={correctedSource('personalPhoneNumber', 'Personal phone')} />}
                {(member.contacts ?? []).map(contact => <ContactRow key={contact.id} icon={contact.kind === 'EMAIL' ? Mail : Phone} value={contact.value}
                  source={`${contact.label ?? (contact.kind === 'EMAIL' ? 'Email' : 'Phone')} · added${contact.addedBy ? ` by ${contact.addedBy}` : ''}`}
                  action={open && <Button size="sm" variant="ghost" className="text-danger" disabled={!!pending} onClick={() => setRemoving({ id: contact.id, value: contact.value })}>Remove<span className="sr-only"> {contact.value}</span></Button>} />)}
                {!accounts?.companyEmail && !accounts?.workPhone && !details?.personalEmail && !details?.personalPhoneNumber && !existing?.personalEmail && !existing?.personalPhone && !telegram && !member.contacts?.length &&
                  <li className="px-4 py-4 text-sm text-muted-foreground sm:px-5">No contacts yet.</li>}
              </ul>
            </Card>
                </div>,
            files: <div className="space-y-6">
              <MemberPhotosCard member={member} name={name} photos={photos} profileUrl={selfieUrl(member.id)} idUrl={idSelfieUrl(member.id)} admin={admin} />
            {member.documents && member.documents.length > 0 && <Card>
              <CardHeader title="Signed documents" />
              <ul className="mt-3 divide-y divide-border border-t border-border">{member.documents.map(doc => <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <span className="flex min-w-0 items-center gap-3"><FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block text-sm font-medium">{doc.title}</span>
                  <span className="text-[13px] text-muted-foreground">Version {doc.version} · signed <LocalTime iso={doc.signedAt} format="date" /></span></span></span>
                <ViewDocumentButton documents={member.documents!.map(item => ({ url: `/api/backend/dispatch/members/${member.id}/documents/${item.id}/signed`, title: `${item.title} · ${member.firstName} ${member.lastName}`, meta: `Signed copy · version ${item.version}` }))} index={member.documents!.indexOf(doc)}>Open signed copy<span className="sr-only"> of {doc.title}</span></ViewDocumentButton>
              </li>)}</ul>
            </Card>}
                  {!member.photo && !member.idPhoto && !member.documents?.length && <p className="text-sm text-muted-foreground">No photos or signed documents.</p>}
            </div>,
            // One timeline of every change (section 38), with MC and team beside it; an older API sends no timeline and gets the earlier cards.
            history: member.timeline ? <div className="grid gap-6 min-[1800px]:grid-cols-[minmax(0,1fr)_320px] min-[1800px]:items-start">
              <HistoryTimeline timeline={member.timeline} />
              {/* Beside the timeline only where the page's own rail leaves room; under it otherwise, as on a phone. */}
              {!gone && mcHistory ? <div className="min-w-0">{mcHistory}</div> : null}
            </div> : <div className="space-y-6">
            <LeaveHistory leaves={member.leaveHistory ?? []} />
            {!!member.noticeHistory?.length && <Card><CardHeader title="Notices" description="Last days that changed, and notices that were cancelled." />
              <CardBody><Timeline items={member.noticeHistory.flatMap(row => [
                ...(row.cancelledAt ? [{ id: `${row.id}-cancelled`, title: `Notice cancelled${row.cancelledBy ? ` by ${row.cancelledBy}` : ''}`, meta: <LocalTime iso={row.cancelledAt} />, body: row.cancelReason ?? undefined }] : []),
                ...[...row.changes].reverse().map((change, index) => ({ id: `${row.id}-${index}`, title: <>Last day changed to <LastDay day={change.to} /></>, meta: <>From <LastDay day={change.from} /> · <LocalTime iso={change.at} /></>, body: change.reason })),
                { id: row.id, title: `Notice recorded${row.recordedBy ? ` by ${row.recordedBy}` : ''}`, meta: <LocalTime iso={row.createdAt} />, body: row.reason }])} /></CardBody></Card>}
            {!!existing?.startDateChanges?.length && <Card><CardHeader title="Start date" description="Dates added or corrected after they were recorded." />
              <CardBody><Timeline items={existing.startDateChanges.map(row => ({ id: row.id, title: <>{row.previousOn ? 'Corrected' : 'Added'}: <LastDay day={row.startedOn} /></>, meta: <>{row.previousOn ? <>Was <LastDay day={row.previousOn} /> · </> : null}{row.changedBy} · <LocalTime iso={row.createdAt} format="date" /></>, body: row.reason ?? undefined }))} /></CardBody></Card>}
            {!!member.supportTypeChanges?.length && <Card><CardHeader title="Position" description="Changes between Support and Updater." />
              <CardBody><Timeline items={member.supportTypeChanges.map(row => ({ id: row.id, title: `Changed to ${supportName({ supportType: row.to })}`, meta: <>{row.changedBy ? `${row.changedBy} · ` : ''}<LocalTime iso={row.createdAt} format="date" /></> }))} /></CardBody></Card>}
            {support && <Card>
              <CardHeader title="Who they assist" description="Every change is recorded, never overwritten." />
              <CardBody><Timeline items={(member.supportHistory ?? []).map(row => ({ id: row.id, tone: row.endedAt ? 'neutral' as const : 'success' as const, icon: <Users aria-hidden="true" />,
                title: row.wholeTeam ? `${row.wholeTeam}, everyone on it` : `${row.dispatcher}${row.dispatcherStatus === 'LEFT' ? ' (left)' : ''}`,
                meta: <>{when(row)} – {row.endedAt ? <LocalTime iso={row.endedAt} format="date" /> : 'today'}{row.changedBy ? ` · by ${row.changedBy}` : ''}</>, body: row.reason ?? undefined }))} /></CardBody>
            </Card>}
            {!gone && mcHistory}
                  {/* One timeline, newest first: onboarding from the invitation to IT setup, each correction (CorrectionHistoryScreen)
                      and, for someone added by hand, their paper scans and when they were added (PaperScanProfileScreen). */}
                  {(!!member.activity?.length || !!member.corrections?.length || !!existing || !!member.recordChanges?.length) && <Card><CardHeader title="History" description={member.corrections?.length ? 'Onboarding and corrections. The application keeps what was sent.' : member.activity?.length && !existing ? 'From the invitation to IT setup.' : undefined} />
                <CardBody><Timeline items={[...correctionItems(member.corrections ?? []), ...(existing ? paperScanItems(existing) : []),
                  ...recordChangeItems(member.recordChanges ?? []).map(({ by, ...item }) => ({ ...item, meta: <>{by ? `${by} · ` : ''}<LocalTime iso={item.at} format="date" /></> })), ...(member.activity ?? []).map(item => ({ id: item.id, at: item.createdAt, title: statusLabel(item.event), meta: <LocalTime iso={item.createdAt} /> }))]
                  .sort((a, b) => b.at.localeCompare(a.at))} /></CardBody></Card>}
            </div>,
          }} />
      </div>
      <div className="min-w-0 space-y-6 xl:sticky xl:top-20">
        {open && <LeaveItCard member={member} leave={leave} restore={member.restore ?? null} />}
        {itOpen && <Alert tone="info" title={`IT setup: ${itOpen.done} of ${itOpen.total} done`}><p>{askedFor(itOpen.items)}, asked <LocalTime iso={itOpen.createdAt} format="date" />{itOpen.requestedBy ? ` by ${itOpen.requestedBy}` : ''}.</p></Alert>}
        {open && existing && (noMc || !startKnown) && <Card><CardHeader title="Still to fill in" />
          <CardBody className="space-y-3"><DescriptionList layout="rows" items={[...(noMc ? [{ label: 'MC and team', value: null, emptyLabel: 'No MC yet' }] : []), ...(!startKnown ? [{ label: 'Started', value: null, emptyLabel: 'Not recorded' }] : [])]} />
            <p className="text-[13px] leading-5 text-muted-foreground">Add {noMc && !startKnown ? 'these' : 'this'} when you know {noMc && !startKnown ? 'them' : 'it'}. Paperwork links, contact details and leaving don’t wait.</p>
            {!startKnown && <Button variant="outline" className="w-full" onClick={() => start('startDate')}><Calendar aria-hidden="true" className="size-4" />Add start date</Button>}</CardBody></Card>}
        {gone ? null : support ? <Card>
          <CardHeader title="Now" />
          <CardBody><DescriptionList layout="rows" items={[
            { label: 'Position', value: called },
            { label: 'Assists', value: supportOf?.wholeTeam ? `Everyone on ${supportOf.wholeTeam}` : supportOf ? <Link href={`/dispatch/dispatchers/${supportOf.dispatcherId}`} className="text-primary underline-offset-4 hover:underline">{supportOf.dispatcher}</Link> : null, emptyLabel: 'No dispatcher' },
            { label: 'MC', value: supportOf ? supportOf.mc ?? 'No MC yet' : null, emptyLabel: '—' },
            { label: 'Team', value: supportOf ? supportOf.team ?? (underMc(supportOf.mc) ? 'Independent (no team)' : null) : null, emptyLabel: '—' },
            { label: 'Since', value: supportOf ? (supportOf.id === undated ? 'Not recorded' : <LocalTime iso={supportOf.startedAt} format="date" />) : null, emptyLabel: '—' }]} /></CardBody>
        </Card> : <Card>
          <CardHeader title="Now" actions={open && <Button variant="ghost" size="sm" onClick={() => start('title')}>Change job title</Button>} />
          <CardBody><DescriptionList layout="rows" items={[
            { label: 'MC', value: current?.mc ? `${current.mc}${current.mcNumber ? ` · MC ${current.mcNumber}` : ''}` : null, emptyLabel: 'No MC yet' },
            { label: 'Team', value: current?.mc ? current.team ?? 'Independent (no team)' : null, emptyLabel: '—' },
            { label: 'Job title', value: member.jobTitle?.name, emptyLabel: 'Not set' },
            { label: 'Since', value: current ? (current.id === undated ? 'Not recorded' : <LocalTime iso={current.startedAt} format="date" />) : null, emptyLabel: '—' },
            // Which team they lead; when they started leading isn't recorded.
            ...(member.leadOf ? [{ label: 'Team lead', value: `Yes, of ${member.leadOf.name}` }] : [])]} /></CardBody>
        </Card>}
        {!support && !!member.supports?.length && <Card>
          <CardHeader title="Supports and updaters" description="Who assists this dispatcher." />
          <ul className="mt-3 divide-y divide-border border-t border-border">{member.supports.map(row => <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
            <span className="min-w-0"><Link href={`/dispatch/dispatchers/${row.id}`} className="block text-sm font-medium text-primary underline-offset-4 hover:underline">{row.name}</Link><span className="text-[13px] text-muted-foreground">{supportName(row)}{row.onLeaveUntil ? <> · On leave until <Day day={row.onLeaveUntil} /></> : null}</span></span>
            {row.sinceKnown !== false && <span className="shrink-0 text-[13px] text-muted-foreground">since <LocalTime iso={row.since} format="date" /></span>}</li>)}</ul>
        </Card>}
        {removal?.scheduled && <Card>
          <CardHeader title="IT access" actions={<Badge label="Scheduled" tone="info" />} />
          <CardBody className="text-sm"><DescriptionList layout="rows" items={[
            { label: 'Company email', value: <>Working until <LastDay day={removal.dueOn} /></> }, { label: 'RingCentral', value: <>Working until <LastDay day={removal.dueOn} /></> },
            { label: 'Email afterwards', value: removal.emailHandedOver ? `Kept for ${removal.handedOverTo ?? 'the person staying'}` : removal.emailAction ? emailAfterText(removal.emailAction, removal.emailAfter === 'FORWARD', removal.forwardTo) : removal.emailAfter === 'FORWARD' ? `Forward to ${removal.forwardTo ?? 'the manager'}, 30 days` : 'Suspend only' },
            { label: 'Remove', value: <>End of <LastDay day={removal.dueOn} /></> }]} /></CardBody></Card>}
        {notice && <Card><CardHeader title="On the last day" /><CardBody><p className="text-[13px] leading-5 text-muted-foreground">Once everyone is reassigned, the workspace marks {member.firstName} as left. A team lead sign-in ends then too. The workspace never messages the person leaving.</p></CardBody></Card>}
        {removal && !removal.scheduled && <Card>
          <CardHeader title="IT access" />
          <CardBody className="space-y-4 text-sm">
            <Progress label="Removal" value={removal.done} max={removal.total} />
            <DescriptionList layout="rows" items={[
              { label: 'Company email', value: emailNow ? emailNow[0].toUpperCase() + emailNow.slice(1) : removal.completedAt ? 'Removed' : 'Being removed' },
              { label: 'RingCentral', value: removal.numberHandedOver ? `Kept for ${removal.handedOverTo ?? 'the person staying'}` : removal.tasks.find(task => task.key === 'RINGCENTRAL')?.status === 'COMPLETED' ? (removal.emailAction ? 'User disabled' : 'Removed') : 'Being removed' },
              { label: removal.completedAt ? 'Removed' : 'Remove by', value: <LocalTime iso={removal.completedAt ?? `${removal.dueOn}T12:00:00Z`} format="date" /> }]} />
          </CardBody>
        </Card>}
        {removalOpen && !removal?.scheduled && <Card><CardHeader title="When it’s done" /><CardBody><p className="text-[13px] leading-5 text-muted-foreground">You get a notification here when IT finishes. The workspace never messages the person who left.</p></CardBody></Card>}
        {/* A support added by hand keeps the accounts a manager recorded beside anything IT set up for them. */}
        {existing && (!accounts || support) && <ExistingAccountsCard member={member} open={open} admin={admin} editing={leftDialog === 'record'} onEditing={value => setLeftDialog(value ? 'record' : null)} />}
        {addedLeft && !removal && <Card><CardHeader title="IT access" /><CardBody><p className="text-[13px] leading-5 text-muted-foreground">{itNotAsked(canAskItToClose(member))}</p></CardBody></Card>}
        {/* Accounts at other companies (section 33): an administrator adds and changes them here. */}
        {member.companyAccounts && <CompanyAccountsCard memberId={member.id} accounts={member.companyAccounts} mcs={mcs} canChange={admin} canAsk={!gone} closingIds={(member.accountRequests ?? []).flatMap(item => item.kind === 'CLOSE' && item.accountId ? [item.accountId] : [])} />}
        {member.accountRequests?.some(item => item.kind === 'MOVE') && <Alert tone="info" title={`IT is setting up their accounts at ${member.accountRequests.find(item => item.kind === 'MOVE')?.toMc ?? 'their new MC'}`}><p>Their record keeps the current accounts until IT finishes. You get a notice then.</p></Alert>}
        {(!existing || accounts) && <Card>
          <CardHeader title={support ? 'Onboarding' : 'IT setup'} />
          <CardBody className="space-y-3 text-sm">
            {support ? (itOpen ? <><p>IT is setting up {askedFor(itOpen.items, true)}.</p>{progress}</>
              : accounts ? <p>From IT setup{accounts.completedAt ? <>, finished <LocalTime iso={accounts.completedAt} format="date" /></> : ''}. IT removes these when {member.firstName} leaves.</p>
              : <p className="text-muted-foreground">Most supports work with their dispatcher’s accounts.{itSetup && open ? ' If they need their own, use More actions › Ask IT to set up.' : ''}</p>)
              : !accounts ? <p className="text-muted-foreground">No IT setup request for this dispatcher.</p>
              : accounts.cancelledAt ? <p>Cancelled <LocalTime iso={accounts.cancelledAt} format="date" />: they left before setup finished.</p>
              : accounts.completedAt ? <p>Setup complete <LocalTime iso={accounts.completedAt} format="date" />.</p>
              : <><p>{restoring ? 'IT is restoring their access, since their leaving was undone.' : member.status === 'ONBOARDING' ? 'In progress. The dispatcher becomes Active when IT finishes.' : 'In progress.'}</p>{progress}</>}
            {accounts && (extension || signIns.dat || signIns.truckstop || member.signIn) && <DescriptionList layout="rows" stacked items={[...(extension ? [{ label: 'Extension', value: extension, mono: true }] : []),
              ...(signIns.dat ? [{ label: 'DAT sign-in', value: <SignIn email={signIns.dat} others={member.sharedSignIns?.dat} /> }] : []), ...(signIns.truckstop ? [{ label: 'Truckstop sign-in', value: <SignIn email={signIns.truckstop} others={member.sharedSignIns?.truckstop} /> }] : []), ...signInItems(member)]} />}
            {member.canOpenApplication && member.applicationId && <Link href={`/onboarding/applications/${member.applicationId}`} className="inline-block text-primary underline-offset-4 hover:underline">Open onboarding record</Link>}
          </CardBody>
        </Card>}
        <p className="text-xs leading-5 text-muted-foreground">Dispatch managers and administrators see this record. Dispatchers don’t have accounts and never see the workspace.</p>
      </div>
    </div>
    {bringing === 'undo' && <UndoLeavingDialog member={member} onClose={() => setBringing(null)} />}
    {bringing === 'rehire' && <RehireDialog member={member} mcs={mcs} teams={teams} jobTitles={jobTitles} dispatchers={dispatchers} onClose={() => setBringing(null)} />}
    {leftDialog === 'names' && <NamesDialog member={member} mcs={mcs} onClose={() => setLeftDialog(null)} />}
    {leftDialog === 'lastDay' && <LeftDayDialog member={member} onClose={() => setLeftDialog(null)} />}
    {leftDialog === 'close' && <CloseAccountsDialog member={member} onClose={() => setLeftDialog(null)} />}
    {action && <Dialog open onClose={() => setAction(null)} busy={pending === 'form'} tone={action === 'leave' || action === 'removeNow' ? 'danger' : undefined} size={action === 'leave' && removesAccess ? 'lg' : undefined} closeLabel={action === 'cancel' ? 'Keep notice' : undefined}
      title={action === 'supportType' ? `Change ${name} to ${otherName}?` : action === 'place' ? `Set ${name}’s MC and team` : action === 'startDate' ? `${startKnown ? 'Correct' : 'Add'} ${name}’s start date` : action === 'reassign' ? `Change who ${name} assists` : action === 'move' ? `Move ${name}` : action === 'leave' ? `Mark ${name} as leaving` : action === 'lastDay' ? `Change ${name}’s last day` : action === 'cancel' ? `Cancel ${name}’s notice?` : action === 'removeNow' ? `Remove ${name}’s access now?` : action === 'title' ? 'Change job title' : action === 'askIt' ? `Ask IT to set up for ${name}` : 'Add email or phone'}
      description={action === 'supportType' ? `Only what they’re called changes. They keep assisting ${supportOf ? assists(supportOf) : 'their dispatcher'}, with the same MC and team.` : action === 'place' ? 'Where they work now. Once they have an MC, in a team or independent, they can be given drivers.' : action === 'startDate' ? (startKnown ? `Now ${new Date(member.joinedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}. Their first period in the history changes with it; later moves stay as they are.` : 'Their start date here, from payroll or an offer letter.') : action === 'reassign' ? `${supportOf ? `Now ${assists(supportOf)}. ` : ''}Their MC and team follow whoever they assist, and the current one stays in the history.` : action === 'move' ? 'The current MC and team end on the start date and stay in the history.' : action === 'leave' ? (leave ? `${member.firstName} is on leave ${leave.started ? `until ${shortDay(leave.backOn)}` : `from ${shortDay(leave.firstDay)}`}. Recording a last day ends the leave.` : 'Record the last day as soon as you know it. The record and its history are kept; leaving a team also ends being its lead.') : action === 'lastDay' ? 'IT’s checklist moves to the new date and shows that it changed.' : action === 'cancel' ? `${member.firstName} stays with no last day. The cancelled notice stays in their history.` : action === 'removeNow' ? 'Use this when they shouldn’t keep their accounts until their last day. It can’t be undone from here.' : action === 'contact' ? 'For another way to reach the dispatcher. Every manager can see it.' : action === 'askIt' ? 'IT gets an alert and a checklist with what you choose. When they finish, you get a notice and the accounts show here.' : undefined}
      actions={<Button type="submit" form="member-action" variant={action === 'leave' || action === 'removeNow' ? 'destructive' : 'default'}>{pending === 'form' ? 'Saving…' : action === 'supportType' ? `Change to ${otherName}` : action === 'place' ? 'Save MC and team' : action === 'startDate' ? 'Save start date' : action === 'reassign' ? 'Save' : action === 'move' ? 'Move dispatcher' : action === 'leave' ? (noticeDay ? 'Record notice' : 'Mark as left') : action === 'lastDay' ? 'Change last day' : action === 'cancel' ? 'Cancel notice' : action === 'removeNow' ? 'Remove access now' : action === 'title' ? 'Save job title' : action === 'askIt' ? 'Send to IT' : 'Add contact'}</Button>}>
      <form id="member-action" onSubmit={submit} className="space-y-4">
        {action === 'place' && <>
          {/* Nothing chosen to begin with: the MC and the team (or Independent) are both picked. */}
          <div className="grid gap-4 sm:grid-cols-2"><Select label="MC" name="mcId" required placeholder="Choose an MC" value={mcId} onChange={event => setMcId(event.target.value)} width="full" options={mcs.filter(mc => !mc.archived).map(mc => ({ value: mc.id, label: mc.name }))} />
            <Select key={mcId} label="Team" name="teamId" required disabled={!mcId} placeholder={mcId ? 'Choose a team' : 'Choose an MC first'} width="full"
            options={mcId ? [{ value: INDEPENDENT, label: 'Independent (no team)' }, ...teamChoices.map(team => ({ value: team.id, label: team.lead ? `${team.name} · ${team.lead.name}` : team.name }))] : []}
            hint={mcId ? 'Independent: works for this MC, not in a team.' : undefined} /></div>
          <Input label="Working there since" optional name="startedAt" type="date" max={today()} width="full" hint="Leave empty if you don’t know. It then follows their start date." />
        </>}
        {action === 'startDate' && <>
          <Input label="Started on" name="startedOn" type="date" required max={today()} min="1980-01-01" defaultValue={startKnown ? member.joinedAt.slice(0, 10) : undefined} width={startKnown ? 'full' : 'sm'} hint="Today or earlier." />
          {startKnown ? <Textarea label="Why it changed" name="reason" required maxLength={500} rows={2} hint="Staff only. Never health or other private details." />
            : current && <Alert tone="info"><p>Their time at {where(current)} starts on this date too.</p></Alert>}
        </>}
        {action === 'reassign' && <>
          <RadioGroup name="assisting" label="They assist" value={assisting} onChange={value => { setAssisting(value); setTarget(''); setNewName(noNewName); }} options={[{ value: 'DISPATCHER', label: 'One dispatcher' }, { value: 'TEAM', label: 'A whole team', description: 'Everyone on the team, with no one dispatcher.' }]} />
          {assisting === 'TEAM' ? <Select label="Team" name="teamId" required placeholder="Choose a team" width="full" value={target} onChange={event => setTarget(event.target.value)}
            options={teams.filter(team => !team.archived && team.name !== supportOf?.wholeTeam).map(team => ({ value: team.id, label: `${team.name} · ${team.mc.name}` }))} />
            : <>{dispatchersFailed && <Alert tone="danger"><p>Couldn’t load dispatchers. Reload the page.</p></Alert>}
          <Select label="New dispatcher" name="dispatcherId" required placeholder="Choose a dispatcher" width="full" value={target} onChange={event => setTarget(event.target.value)}
            options={dispatchers.filter(option => option.id !== supportOf?.dispatcherId).map(option => ({ value: option.id, label: [option.name, option.mc ?? 'No MC yet', underMc(option.mc) ? option.team ?? 'Independent' : null].filter(Boolean).join(' · ') }))} /></>}
          <Input label="Starts on" name="startedAt" type="date" required defaultValue={today()} max={today()} width="sm" />
          <Textarea label="Reason" name="reason" required maxLength={500} rows={3} hint="For the history, such as Blake needed help with updates." />
          {assistMc && <NewNameQuestion optional value={newName} onChange={setNewName} oldName={name} mc={assistMc} fromMc={nowMc} />}
        </>}
        {action === 'move' && <>
          <Select label="MC" name="mcId" required placeholder="Choose an MC" value={mcId} onChange={event => setMcId(event.target.value)} width="full"
            options={mcs.filter(mc => !mc.archived).map(mc => ({ value: mc.id, label: mc.name }))} />
          <Select key={mcId} label="Team" name="teamId" required disabled={!mcId} defaultValue={current?.mcId === mcId ? (current?.teamId && teamChoices.some(team => team.id === current.teamId) ? current.teamId : current?.teamId ? '' : INDEPENDENT) : ''} placeholder={mcId ? 'Choose a team' : 'Choose an MC first'} width="full"
            options={mcId ? [{ value: INDEPENDENT, label: 'Independent (no team)' }, ...teamChoices.map(team => ({ value: team.id, label: team.lead ? `${team.name} · ${team.lead.name}` : team.name }))] : []}
            hint={mcId ? 'Independent: works for this MC, not in a team.' : undefined} />
          {member.leadOf && <p className="rounded-md bg-warning-background px-3 py-2 text-sm text-warning">{name} leads {member.leadOf.name}. Moving to another team ends that.</p>}
          <Input label="Starts on" name="startedAt" type="date" required defaultValue={today()} max={today()} width="sm" />
          <Textarea label="Reason" name="reason" required maxLength={500} rows={3} hint="For the history, such as Lakeside needed more dispatchers." />
          {moveMc && <NewNameQuestion value={newName} onChange={setNewName} oldName={name} mc={moveMc} fromMc={current?.mc ?? null} />}
          {mcId && mcId !== current?.mcId && <MoveAccounts value={moveAccounts} onChange={setMoveAccounts} toMc={mcs.find(mc => mc.id === mcId)?.name ?? 'the new MC'} fromMc={current?.mc ?? null}
            email={accounts?.companyEmail ?? existing?.companyEmail ?? null} number={accounts?.workPhone ?? existing?.ringCentralNumber ?? null}
            keptFor={[...new Set((member.loadBoardSeats ?? []).filter(seat => seat.status !== 'ENDED' && seat.signInEmail === (accounts?.companyEmail ?? existing?.companyEmail)).map(seat => seat.account))]} />}
        </>}
        {action === 'leave' && <>
          <Input label="Last day" name="leftAt" type="date" required value={lastDay} onChange={event => setLastDay(event.target.value)} max={support || !accounts || accounts.completedAt ? noticeLimit() : today()} width="sm"
            hint={support || !accounts || accounts.completedAt ? (leave ? `Today, or up to ${NOTICE_MAX_DAYS} days ahead.` : `Up to ${NOTICE_MAX_DAYS} days ahead.`) : 'Today or earlier: their IT setup isn’t finished.'} />
          <Textarea label={noticeDay ? 'Why they’re leaving' : 'Why they left'} name="reason" required maxLength={500} rows={2} hint="Staff only. Never health or other private details." />
          {leave && <LeavingCoveredAlert leave={leave} />}
          {leave && <Alert tone="info" title={leave.suspend ? 'IT’s suspend checklist becomes a removal' : 'Their leave ends'}><p>{leave.suspend ? 'Restoring is cancelled. The removal shows what is already suspended, so IT only finishes the rest.' : 'Nothing was suspended, so IT has nothing to restore.'}{anyoneLeft ? ` Their ${[drivers.length ? `${drivers.length} driver${drivers.length === 1 ? '' : 's'}` : '', supportsLeft.length ? helperWords(supportsLeft) : ''].filter(Boolean).join(' and ')} still need reassigning by the last day.` : ''}</p></Alert>}
          {noticeDay && <Alert tone="info" title={<>{member.firstName} stays {badge.label} until <LastDay day={lastDay} /></>}><p>They keep working, with their drivers and accounts, until the end of that day. Then the workspace marks them as left.</p></Alert>}
          {noticeDay && anyoneLeft && <Alert tone="warning" title={<>{reassign} to reassign by <LastDay day={lastDay} /></>}><p>You can do this during the notice. They can’t be marked as left until it’s done.</p></Alert>}
          {removesAccess && <Card><CardHeader title="IT removes their access" description={noticeDay ? 'IT gets the removal checklist and a Telegram alert now, so it can prepare.' : 'Mark as left starts an IT removal checklist and alerts the IT team on Telegram.'} />
            <CardBody className="space-y-4"><DescriptionList layout="rows" items={[
              { label: 'Company email', value: accounts?.companyEmail ?? recordedAccounts?.companyEmail, emptyLabel: recordedAccounts ? 'Not recorded' : 'None recorded' },
              { label: 'RingCentral number', value: phoneLabel(accounts?.workPhone ?? recordedAccounts?.ringCentralNumber), mono: true, emptyLabel: recordedAccounts ? 'Not recorded' : 'None recorded' },
              ...(signIns.dat ? [{ label: 'DAT sign-in', value: <SignIn email={signIns.dat} others={member.sharedSignIns?.dat} /> }] : []), ...(signIns.truckstop ? [{ label: 'Truckstop sign-in', value: <SignIn email={signIns.truckstop} others={member.sharedSignIns?.truckstop} /> }] : []),
              { label: noticeDay ? 'Remove' : 'Remove by', value: noticeDay ? <>At the end of <LastDay day={lastDay} />, not before</> : 'End of their last day' }]} />
              {(accounts?.companyEmail || recordedAccounts?.companyEmail) && !(handOverTo && member.sharing?.usedBy.some(item => item.kind === 'EMAIL')) && <EmailAfterFields email={(accounts?.companyEmail || recordedAccounts?.companyEmail)!} value={emailChoice} onChange={setEmailChoice} />}
              {(accounts?.workPhone || recordedAccounts?.ringCentralNumber) && <p className="text-[13px] leading-5 text-muted-foreground">IT disables their RingCentral user. The number stays with it and isn’t given to anyone else.</p>}
            </CardBody></Card>}
          <HandOverChoice member={member} value={handOverTo} onChange={setHandOverTo} />
          {handOverTo && member.sharing?.usedBy.some(item => item.kind === 'EMAIL') && <p className="text-[13px] leading-5 text-muted-foreground">Their email goes to {member.sharing.usedBy.flatMap(item => item.users).find(user => user.id === handOverTo)?.name} with the mailbox, so there’s nothing to forward.</p>}
          {!noticeDay && <p className="text-[13px] leading-5 text-muted-foreground">A dispatcher with drivers, supports or updaters can’t be marked as left: reassign them first, or choose a later last day.</p>}
        </>}
        {action === 'lastDay' && <>
          <Input label="New last day" name="lastDay" type="date" required value={lastDay} onChange={event => setLastDay(event.target.value)} min={today()} max={noticeLimit()} width="sm" hint={<>Now <LastDay day={notice?.lastDay ?? today()} />. Today, or up to {NOTICE_MAX_DAYS} days ahead.</>} />
          <Textarea label="Why it changed" name="reason" required maxLength={500} rows={2} hint="Staff only. Never health or other private details." />
          <Alert tone="info"><p>Choosing today means they leave at the end of today, once everyone is reassigned.</p></Alert>
        </>}
        {action === 'cancel' && <>
          <Textarea label="Why they’re staying" name="reason" required maxLength={500} rows={2} hint="Staff only. Never health or other private details." />
          <Alert tone="info"><p>IT’s removal checklist is cancelled too. Once IT has started removing anything, or access removal was requested now, the notice can’t be cancelled: talk to IT.</p></Alert>
        </>}
        {action === 'removeNow' && <>
          <Textarea label="Why now" name="reason" required maxLength={500} rows={2} hint="Staff only. Never health or other private details." />
          <DescriptionList layout="rows" items={[{ label: 'IT', value: 'Removal due today; IT gets a Telegram alert now' }, { label: 'Team lead sign-in', value: 'Turned off now, if they have one' }, { label: 'Last day', value: <>Stays <LastDay day={notice?.lastDay ?? today()} /> until you change it</> }]} />
          {anyoneLeft && <Alert tone="warning" title={`Reassign their ${reassign}`}><p>{member.firstName} won’t be able to work with them without access. Removing access never waits for this.</p></Alert>}
        </>}
        {action === 'askIt' && <>
          <SupportItChoices value={itItems} onChange={next => { setItItems(next); setError(''); }} />
          <Textarea label="Note for IT" optional name="note" maxLength={1000} rows={3} hint="What they need it for. Never passwords." />
        </>}
        {action === 'title' && <Select label="Job title" name="jobTitleId" defaultValue={member.jobTitle?.id ?? ''} placeholder="Not set" width="full"
          options={jobTitles.filter(title => !title.archived || title.id === member.jobTitle?.id).map(title => ({ value: title.id, label: title.name }))} />}
        {action === 'contact' && <>
          <Select label="Type" name="kind" value={kind} onChange={event => setKind(event.target.value as 'EMAIL' | 'PHONE')} width="sm" options={[{ value: 'PHONE', label: 'Phone number' }, { value: 'EMAIL', label: 'Email' }]} />
          <Input key={kind} label={kind === 'EMAIL' ? 'Email' : 'Phone number'} name="value" type={kind === 'EMAIL' ? 'email' : 'tel'} required maxLength={kind === 'EMAIL' ? 254 : 40} autoComplete="off" width="md"
            hint={kind === 'PHONE' ? 'Include the country code, such as +1 469 555 0181.' : undefined} />
          <Input label="Label" optional name="label" maxLength={50} autoComplete="off" width="md" hint="Such as Second phone or Spouse." />
        </>}
        <Notice message={error} error />
      </form>
    </Dialog>}
    {leaveAction === 'covers' && leave ? <ChangeCoversDialog member={member} leave={leave} onClose={() => setLeaveAction(null)} />
      : leaveAction && leaveAction !== 'covers' && <LeaveDialog action={leaveAction} member={member} onClose={() => setLeaveAction(null)} />}
    {correcting && <CorrectDetailsDialog member={member} onClose={() => setCorrecting(false)} />}
    {naming && <ChangeNameDialog member={member} mcs={mcs} onClose={() => setNaming(false)} />}
    {removing && <Dialog open size="sm" tone="danger" onClose={() => setRemoving(null)} busy={pending === removing.id} protectChanges={false} title="Remove this contact?"
      description="It no longer shows on this record. Who added and removed it, and when, are kept."
      actions={<Button variant="destructive" onClick={() => void removeContact(removing.id)}>{pending === removing.id ? 'Removing…' : 'Remove contact'}</Button>}>
      <p className="break-all text-sm font-medium">{removing.value}</p>
    </Dialog>}
  </div>;
}
