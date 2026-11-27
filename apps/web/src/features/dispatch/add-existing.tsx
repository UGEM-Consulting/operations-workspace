'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { ArrowLeft, Download, Plus, Upload, X } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Input, RadioGroup, Select, Textarea } from '@/components/ui/field';
import { PendingHint } from '@/components/ui/pending-hint';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { existingCsv, MAX_ROWS, readExistingFile, TEMPLATE, type ExistingRow, type SharedAction } from './existing-csv';
import { PreviousOwnerWarning, type PreviousOwnerItem, useAccountOwners } from './shared-accounts';
import { supportName } from './types';
import { dayLabel } from '@/lib/navigation';

export interface ExistingOptions { archivedMcs?: { id: string; name: string }[]; archivedTeams?: { id: string; name: string; mcId: string }[]; loadBoardAccounts?: { id: string; name: string; provider: 'DAT' | 'TRUCKSTOP'; placeholder: boolean }[]; mcs: { id: string; name: string }[]; teams: { id: string; name: string; mcId: string; lead: string | null }[]; jobTitles: { id: string; name: string }[]; dispatchers: { id: string; name: string; mc?: string | null }[] }
type Status = 'READY' | 'CHOICE' | 'PROBLEM' | 'ALREADY';
/** Someone already recorded that a row matches (section 33): what the file would add, and what can be done with the row. */
interface Match { id: string; name: string; status: string; why: string; options: ('FILL' | 'CAME_BACK' | 'DIFFERENT' | 'ACCOUNT')[]; fills: string[]; account?: { mcId: string; mc: string; adds: string[] } }
/** Someone else's company email or RingCentral number on a row naming a different person (section 35). */
interface SharedMatch { owners: { id: string; name: string; fields: ('companyEmail' | 'ringCentralNumber')[] }[]; options: SharedAction[] }
interface CheckedRow { row: number; name: string; position: string; supportType?: string; status: Status; problems: string[]; sameName: boolean; left?: boolean; leftOn?: string | null; hasAccounts?: boolean; match?: Match | null; shared?: SharedMatch | null; sharedAction?: SharedAction | null;
  /** Section 44: a company email or number in the row that was someone's who left; an older API sends none. */
  previous?: { field: 'companyEmail' | 'ringCentralNumber'; name: string; until: string | null }[] | null; previousAction?: 'WITHOUT' | 'CONFIRMED' | null }
/** "company email and RingCentral number", "company email" or "RingCentral number". */
const fieldsWord = (fields: string[]) => fields.length > 1 ? 'company email and RingCentral number' : fields[0] === 'companyEmail' ? 'company email' : 'RingCentral number';
/** What each choice says, from the row's person and the one who has it now (SharedCheckRowsScreen). */
function sharedLabel(option: SharedAction, person: string, owner: string, both: boolean) {
  const them = both ? 'them' : 'it';
  return option === 'SHARED' ? `Add ${person}, using ${owner}’s (shared)` : option === 'MOVE_SHARED' ? `${person}’s, and ${owner} uses ${them} too` : option === 'MOVE' ? `${person}’s: move ${them} from ${owner}` : `Add ${person} without ${them}`;
}
interface Checked { rows: CheckedRow[]; choices: { field: 'mc' | 'team' | 'jobTitle' | 'datAccount' | 'truckstopAccount'; text: string; mc?: string; forSupports?: boolean; rows: number[] }[]; counts: { ready: number; choice: number; problem: number; already: number; noStartDate?: number; noMc?: number; mcFromTeam?: number; wholeTeam?: number; sharedSignIn?: number; left?: number; noLastDay?: number; fill?: number } }
interface Added { added: number; accounts?: number; filled?: number; members: { row: number; id: string }[]; left: { row: number; name: string; status: Status; problems: string[]; sameName?: boolean; previous?: { field: 'companyEmail' | 'ringCentralNumber'; name: string; until: string | null }[] | null }[] }
const STEPS = ['Upload the file', 'Check the rows', 'Add dispatchers'];
const key = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
// Independent is a team choice under an MC (no team), never an MC; the API reads it the same in a file's team column.
const INDEPENDENT = 'Independent', NO_MC = 'No MC yet';
const OPTION_LABELS = { SKIP: 'Skip this row', FILL: 'Add missing details', CAME_BACK: 'Same person, came back', DIFFERENT: 'A different person, add them', ACCOUNT: 'Add as their account' } as const;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** The notice above the rows: what will be added with details missing, and which MCs came from a team. */
function missingNote({ noStartDate = 0, noMc = 0, mcFromTeam = 0 }: Checked['counts']) {
  const rows = (count: number) => `${count} ${count === 1 ? 'row' : 'rows'}`, has = (count: number) => count === 1 ? 'has' : 'have';
  const missing = [noStartDate ? `${noStartDate} ${has(noStartDate)} no start date` : '', noMc ? `${noMc} ${has(noMc)} no MC` : ''].filter(Boolean).join(' and ');
  return { title: missing ? 'Some ready rows are missing details' : 'MCs came from their teams', body: [missing ? `${missing}. They’ll be added as they are, and you can fill these in on their page later.` : '', mcFromTeam ? `${rows(mcFromTeam)} took ${mcFromTeam === 1 ? 'its MC from its team' : 'their MC from their team'}.` : ''].filter(Boolean).join(' ') };
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
function Steps({ current }: { current: number }) {
  return <ol className="grid gap-2 sm:grid-cols-3" aria-label="Steps">{STEPS.map((label, index) => <li key={label} aria-current={index === current ? 'step' : undefined}
    className={`rounded-md border px-3 py-2 text-xs ${index === current ? 'border-primary bg-brand-subtle font-semibold text-brand-subtle-foreground' : 'border-border text-muted-foreground'}`}>{index + 1}. {label}</li>)}</ol>;
}
function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border bg-card p-4 shadow-xs"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p></div>;
}

/** Dispatch › Dispatchers › Add existing dispatchers. The browser reads the file; only its rows go to the API, which checks them and keeps only the records. */
export function AddExisting({ options }: { options: ExistingOptions }) {
  const router = useRouter(), toast = useToast(), input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState(''), [rows, setRows] = useState<ExistingRow[]>([]), [checked, setChecked] = useState<Checked | null>(null), [done, setDone] = useState<Added | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [adding, setAdding] = useState(false), [one, setOne] = useState(false);
  const [chosen, setChosen] = useState<Record<number, Match>>({});
  async function check(next: ExistingRow[]) {
    setBusy(true); setError('');
    try { setChecked(await mutate<Checked>('dispatch/existing/check', 'POST', { rows: next })); setRows(next); }
    catch (failure) { setError(errorMessage(failure, 'Unable to check the rows. Your file hasn’t been saved.')); }
    finally { setBusy(false); }
  }
  async function pick(file: File | undefined) {
    if (!file) return;
    if (file.size > 900_000) { setError('This file is too large. Upload up to 500 rows at a time.'); return; }
    const read = readExistingFile(await file.text());
    if (read.error !== undefined) { setError(read.error); return; }
    setFileName(file.name); await check(read.rows);
  }
  /** One choice fixes every row with that text. */
  function choose(choice: Checked['choices'][number], value: string) {
    if (!value) return;
    const field = choice.field === 'mc' ? 'mc' : choice.field === 'team' ? 'team' : choice.field === 'datAccount' || choice.field === 'truckstopAccount' ? choice.field : 'jobTitle';
    void check(rows.map(row => !choice.rows.includes(row.row) ? row : value === NO_MC ? { ...row, mc: NO_MC, team: '' } : { ...row, [field]: value }));
  }
  async function add() {
    setBusy(true); setError('');
    try {
      const result = await mutate<Added>('dispatch/existing/add', 'POST', { rows, sourceName: fileName });
      setDone(result); setAdding(false); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'Unable to add them. Nothing was saved.')); setAdding(false); }
    finally { setBusy(false); }
  }
  /** What to do with a row that matches someone recorded: Skip clears the choice, and the row is checked again. */
  function decide(row: number, match: Match, value: string) {
    setChosen(current => { const next = { ...current }; if (value === 'SKIP') delete next[row]; else next[row] = match; return next; });
    void check(rows.map(item => item.row !== row ? item : { ...item, alreadyAction: value === 'FILL' || value === 'CAME_BACK' || value === 'ACCOUNT' ? value : undefined, differentPerson: value === 'DIFFERENT' ? true : undefined }));
  }
  /** Someone else's email or number: the row is checked again with the choice, or without one to skip it. */
  function share(row: number, value: string) { void check(rows.map(item => item.row !== row ? item : { ...item, sharedAction: value ? value as SharedAction : undefined })); }
  const sharedRows = (checked?.rows ?? []).flatMap(row => row.shared ? [{ ...row, shared: row.shared }] : []);
  const previousRows = (checked?.rows ?? []).flatMap(row => row.previous?.length ? [{ ...row, previous: row.previous }] : []);
  function previousChoice(row: number, value: string) { void check(rows.map(item => item.row !== row ? item : { ...item, previousOwnerAction: value ? value as 'WITHOUT' | 'CONFIRMED' : undefined })); }
  const matched = (checked?.rows ?? []).flatMap(row => { const match = row.match ?? chosen[row.row]; return match ? [{ ...row, match }] : []; });
  const choiceOf = (row: number) => { const item = rows.find(entry => entry.row === row); return item?.alreadyAction ?? (item?.differentPerson && chosen[row] ? 'DIFFERENT' : 'SKIP'); };
  const leaving = checked?.rows.filter(row => row.left && row.status === 'READY' && !chosen[row.row]) ?? [];
  const fileRow = (row: number) => rows.find(item => item.row === row);
  const lookAt = checked?.rows.filter(row => !row.match && !chosen[row.row] && (row.status === 'PROBLEM' || row.status === 'ALREADY' || (row.status === 'CHOICE' && row.problems.length))) ?? [];
  const leftOut = rows.filter(row => lookAt.some(item => item.row === row.row));
  const tones: Record<Status, 'danger' | 'neutral' | 'warning' | 'success'> = { PROBLEM: 'danger', ALREADY: 'neutral', CHOICE: 'warning', READY: 'success' };
  const labels: Record<Status, string> = { PROBLEM: 'Problem', ALREADY: 'Already here', CHOICE: 'Needs a choice', READY: 'Ready' };

  if (done) return <div className="space-y-6">
    <Steps current={2} />
    <Alert tone="success" title={`Added ${plural(done.added, 'person', 'people')}${done.filled ? `, filled in ${done.filled}` : ''}${done.accounts ? `, ${plural(done.accounts, 'account', 'accounts')} at other companies` : ''}`}><p>People who work here are Active and people who left are under the Left tab. Nobody was messaged, and IT was asked only to close the accounts you ticked.</p></Alert>
    {done.left.length > 0 && <Card><CardHeader title={`${done.left.length} ${done.left.length === 1 ? 'row' : 'rows'} left out`} description="Correct these and upload them again. Rows already added show as Already here." />
      <Table caption="Rows left out" rows={done.left} rowKey={row => String(row.row)} columns={[{ key: 'row', label: 'Row', nowrap: true, cell: row => row.row }, { key: 'name', label: 'Person', primary: true, cell: row => row.name || 'No name' }, { key: 'why', label: 'Why', cell: row => row.problems.join(' ') || 'It still needs a choice.' }]} /></Card>}
    <div className="flex flex-wrap gap-2"><Button asChild><Link href="/dispatch/dispatchers?status=PAPERWORK">Go to Paperwork</Link></Button><Button asChild variant="outline"><Link href="/dispatch/dispatchers?status=LEFT">See who left</Link></Button><Button asChild variant="outline"><Link href="/dispatch/dispatchers?status=MISSING">See missing details</Link></Button><Button variant="outline" onClick={() => { setDone(null); setChecked(null); setRows([]); setFileName(''); setChosen({}); }}>Upload another file</Button></div>
  </div>;

  if (checked) return <div className="space-y-6">
    <p className="text-sm text-muted-foreground">{fileName}, {checked.rows.length} {checked.rows.length === 1 ? 'row' : 'rows'}. Nothing is saved yet.</p>
    <Steps current={1} />
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4"><Stat label="Ready to add" value={checked.counts.ready} /><Stat label="Need a choice" value={checked.counts.choice} /><Stat label="Have a problem" value={checked.counts.problem} /><Stat label="Already here" value={checked.counts.already} /></div>
    {!!checked.counts.left && <Alert tone="info" title={`${plural(checked.counts.left, 'person who left', 'people who left')} will be added as Left`}><p>They show under the Left tab with the reason from the file. Nobody is messaged and they get no sign-in.{checked.counts.noLastDay ? ` ${checked.counts.noLastDay} ${checked.counts.noLastDay === 1 ? 'has' : 'have'} no last day; you can add it on their page.` : ''}</p></Alert>}
    {(!!checked.counts.noStartDate || !!checked.counts.noMc || !!checked.counts.mcFromTeam) && <Alert tone="info" title={missingNote(checked.counts).title}><p>{missingNote(checked.counts).body}</p></Alert>}
    {!!checked.counts.wholeTeam && <Alert tone="info" title={`${checked.counts.wholeTeam} ${checked.counts.wholeTeam === 1 ? 'person assists' : 'people assist'} a whole team`}><p>They have a team and no dispatcher, so they’ll assist everyone on it. If that’s wrong, name their dispatcher in the file.</p></Alert>}
    {!!checked.counts.sharedSignIn && <Alert tone="info" title={`${checked.counts.sharedSignIn} ${checked.counts.sharedSignIn === 1 ? 'person shares' : 'people share'} a load board sign-in`}><p>That’s allowed. Each person’s page says who else uses it, and IT is told before closing it.</p></Alert>}
    {checked.choices.length > 0 && <Card><CardHeader title="Choose what these mean" description="Each choice fixes every row with that text. If it’s missing from the list, add it in Admin › Lists or Dispatch › Teams, then upload again." />
      <ul className="mt-3 divide-y divide-border border-t border-border">{checked.choices.map(choice => {
        const mc = options.mcs.find(item => key(item.name) === key(choice.mc ?? ''));
        const mcOf = (id: string) => options.mcs.find(item => item.id === id)?.name;
        const choices = choice.field === 'mc' ? [{ value: NO_MC, label: NO_MC }, ...options.mcs.map(item => ({ value: item.name, label: item.name }))]
          : choice.field === 'team' && !choice.mc ? [...options.teams.filter(item => mcOf(item.mcId)).map(item => ({ value: item.name, label: `${item.name} · ${mcOf(item.mcId)}` })), ...(choice.forSupports ? [] : [{ value: NO_MC, label: NO_MC }])]
          : choice.field === 'team' ? [{ value: INDEPENDENT, label: 'Independent (no team)' }, ...options.teams.filter(item => item.mcId === mc?.id).map(item => ({ value: item.name, label: item.lead ? `${item.name} · ${item.lead}` : item.name }))]
          : choice.field === 'datAccount' || choice.field === 'truckstopAccount' ? (options.loadBoardAccounts ?? []).filter(item => item.provider === (choice.field === 'datAccount' ? 'DAT' : 'TRUCKSTOP')).map(item => ({ value: item.name, label: item.name }))
          : options.jobTitles.map(item => ({ value: item.name, label: item.name }));
        const what = choice.field === 'mc' ? 'MC' : choice.field === 'team' ? 'Team' : choice.field === 'datAccount' ? 'DAT account' : choice.field === 'truckstopAccount' ? 'Truckstop account' : 'Job title';
        return <li key={`${choice.field}-${choice.forSupports}-${choice.mc}-${choice.text}`} className="flex flex-wrap items-end justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-[1_1_240px]"><p className="text-sm font-medium">{what} “{choice.text}”{choice.mc ? ` at ${choice.mc}` : ''}</p><p className="text-[13px] text-muted-foreground">{choice.rows.length} {choice.rows.length === 1 ? 'row' : 'rows'}{choice.forSupports ? ', a support or updater for the whole team' : choice.field === 'team' && !choice.mc ? ', no MC in the file' : ''}</p></div>
          <Select label={`Use this ${what === 'MC' ? 'MC' : what.endsWith('account') ? 'account' : what.toLowerCase()}`} value="" placeholder="Choose" options={choices} disabled={busy} width="sm" onChange={event => choose(choice, event.target.value)} />
        </li>;
      })}</ul></Card>}
    {leaving.length > 0 && <Card><CardHeader title="People who left" description="Tick anyone whose company email, number or load board access may still be open. IT gets a removal checklist from what’s recorded." />
      <Table className="mt-3 border-t border-border" caption="People who left" rows={leaving} rowKey={row => String(row.row)} columns={[
        { key: 'row', label: 'Row', nowrap: true, cell: row => row.row },
        { key: 'person', label: 'Person', primary: true, cell: row => <Person name={row.name || 'No name'} secondary={[row.position === 'SUPPORT' ? supportName(row) : 'Dispatcher', fileRow(row.row)?.mc || fileRow(row.row)?.team].filter(Boolean).join(' · ')} /> },
        { key: 'day', label: 'Last day', nowrap: true, cell: row => row.leftOn ? dayLabel(row.leftOn) : <span className="text-muted-foreground">Not recorded</span> },
        { key: 'why', label: 'Why they left', cell: row => fileRow(row.row)?.leftReason || <span className="text-muted-foreground">—</span> },
        { key: 'it', label: 'Ask IT to close their accounts', cell: row => row.hasAccounts ? <Checkbox label="Ask IT" checked={!!fileRow(row.row)?.askIt} disabled={busy}
          description={[fileRow(row.row)?.companyEmail && 'Company email', fileRow(row.row)?.ringCentralNumber && 'number', (fileRow(row.row)?.datEmail || fileRow(row.row)?.truckstopEmail) && 'load board sign-in'].filter(Boolean).join(', ').replace(/^./, letter => letter.toUpperCase()) + ' recorded'}
          onChange={event => { const ask = event.target.checked; setRows(list => list.map(item => item.row === row.row ? { ...item, askIt: ask || undefined } : item)); }} /> : <span className="text-[13px] text-muted-foreground">No accounts recorded</span> }]} /></Card>}
    {sharedRows.length > 0 && <Card><CardHeader title="Someone else’s email or number" description="These rows name a different person but use an email or number already recorded. Choose for each; a row without a choice is skipped." />
      <ul className="mt-3 divide-y divide-border border-t border-border">{sharedRows.map(row => {
        const first = row.name.split(' ')[0] || 'them', owner = row.shared.owners[0], both = row.shared.owners.flatMap(item => item.fields).length > 1;
        return <li key={row.row} className="flex flex-wrap items-end justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-[1_1_320px]"><Person name={row.name || 'No name'} secondary={`Row ${row.row} · same ${row.shared.owners.map(item => `${fieldsWord(item.fields)} as ${item.name}`).join(', and ')}, Active`} /></div>
          <Select label="What to do" value={rows.find(item => item.row === row.row)?.sharedAction ?? ''} disabled={busy} width="md" onChange={event => share(row.row, event.target.value)}
            options={[{ value: '', label: 'Choose… (skips the row)' }, ...row.shared.options.map(option => ({ value: option, label: sharedLabel(option, first, owner.name.split(' ')[0], both) }))]} />
        </li>;
      })}</ul></Card>}
    {previousRows.length > 0 && <Card><CardHeader title="Was someone else’s" description="An email or number here belonged to someone who left. Choose what to do with each; a row without a choice is skipped." />
      <ul className="mt-3 divide-y divide-border border-t border-border">{previousRows.map(row => {
        const first = row.name.split(' ')[0] || 'them', what = row.previous.length > 1 ? 'email and number' : row.previous[0].field === 'companyEmail' ? 'email' : 'number';
        return <li key={row.row} className="flex flex-wrap items-end justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-[1_1_320px]"><Person name={row.name || 'No name'} secondary={`Row ${row.row} · ${row.previous.map(item => `${item.field === 'companyEmail' ? 'company email' : 'RingCentral number'} was ${item.name}’s${item.until ? ` until ${new Date(item.until).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}` : ''}`).join(', and ')}`} /></div>
          <Select label="What to do" value={rows.find(item => item.row === row.row)?.previousOwnerAction ?? ''} disabled={busy} width="md" onChange={event => previousChoice(row.row, event.target.value)}
            options={[{ value: '', label: 'Choose… (skips the row)' }, { value: 'WITHOUT', label: `Add without the ${what}` }, { value: 'CONFIRMED', label: `IT confirmed it’s ${first}’s now` }]} />
        </li>;
      })}</ul></Card>}
    {matched.length > 0 && <Card><CardHeader title="Already here" description="These people have a record. Choose what to do with each row; leaving it means the row is skipped." />
      <ul className="mt-3 divide-y divide-border border-t border-border">{matched.map(row => <li key={row.row} className="flex flex-wrap items-end justify-between gap-3 px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-[1_1_320px]"><Person name={row.match.name} secondary={`Row ${row.row}${row.left ? ' · Left in the file' : ''} · ${row.match.why}`} />
          <p className="mt-1 pl-11 text-[13px] text-muted-foreground">{choiceOf(row.row) === 'ACCOUNT' && row.match.account ? `Adds their account at ${row.match.account.mc}: ${row.match.account.adds.join(', ')}. Nothing else on their record changes.` : choiceOf(row.row) === 'CAME_BACK' ? 'Same person, came back: a new record linked to the old one, which stays as history.' : choiceOf(row.row) === 'DIFFERENT' ? 'Added as a new person.' : row.match.fills.length ? `The file adds: ${row.match.fills.join(', ')}.` : row.match.options.length ? 'Nothing new: every value in the row is already recorded.' : row.problems[0]}</p></div>
        {row.match.options.length > 0 && <Select label="What to do" value={choiceOf(row.row)} disabled={busy} width="sm" onChange={event => decide(row.row, row.match, event.target.value)}
          options={[{ value: 'SKIP', label: OPTION_LABELS.SKIP }, ...row.match.options.map(option => ({ value: option, label: option === 'ACCOUNT' && row.match.account ? `Add as their account at ${row.match.account.mc}` : OPTION_LABELS[option] }))]} />}
      </li>)}</ul>
      <div className="border-t border-border px-4 py-3 sm:px-5"><p className="text-[13px] text-muted-foreground">Recorded values never change here. A value that differs from what’s recorded is left as it is. An administrator can change it with Correct details, with a reason.</p></div></Card>}
    {lookAt.length > 0 && <Card><CardHeader title="Rows to look at" actions={<Button size="sm" variant="outline" onClick={() => download('rows-to-correct.csv', existingCsv(leftOut))}><Download aria-hidden="true" className="size-4" />Download these rows</Button>} />
      <Table className="mt-3 border-t border-border" caption="Rows with a problem or already recorded" rows={lookAt} rowKey={row => String(row.row)} columns={[
        { key: 'row', label: 'Row', nowrap: true, cell: row => row.row },
        { key: 'person', label: 'Person', primary: true, cell: row => <Person name={row.name || 'No name'} secondary={row.position === 'SUPPORT' ? supportName(row) : 'Dispatcher'} /> },
        { key: 'why', label: 'What’s wrong', cell: row => <>{row.problems.join(' ')}{row.sameName && <Button size="sm" variant="ghost" className="ml-1" disabled={busy} onClick={() => void check(rows.map(item => item.row === row.row ? { ...item, differentPerson: true } : item))}>They’re different people</Button>}</> },
        { key: 'status', label: 'Status', cell: row => <Badge label={labels[row.status]} tone={tones[row.status]} /> }]} /></Card>}
    {(checked.counts.choice > 0 || checked.counts.problem > 0) && <Alert tone="info" title="You don’t have to fix everything now"><p>You can add the rows that are ready, then correct the others and upload them again. A row already added shows as Already here.</p></Alert>}
    <Notice message={error} error /><PendingHint pending={busy} />
    <div className="flex flex-wrap justify-between gap-3"><Button variant="ghost" disabled={busy} onClick={() => { setChecked(null); setRows([]); setError(''); }}><ArrowLeft aria-hidden="true" className="size-4" />Upload a different file</Button>
      <Button disabled={busy || !(checked.counts.ready + (checked.counts.fill ?? 0))} onClick={() => setAdding(true)}><Plus aria-hidden="true" className="size-4" />Add {plural(checked.counts.ready, 'person', 'people')}{checked.counts.fill ? `, fill in ${checked.counts.fill}` : ''}</Button></div>
    {adding && <Dialog open onClose={() => setAdding(false)} busy={busy} title={`Add ${plural(checked.counts.ready, 'person', 'people')}${checked.counts.fill ? `, fill in ${checked.counts.fill}` : ''}?`} description={`${checked.counts.left ? 'People who left are added as Left; everyone else is Active straight away. ' : 'They become Active straight away, '}with no application and no IT setup, and nobody is messaged. Rows that aren’t ready are left out.`}
      actions={<Button disabled={busy} onClick={() => void add()}>{busy ? 'Adding…' : 'Add them'}</Button>}><PendingHint pending={busy} /><p className="text-sm text-muted-foreground">Paper dates you entered confirm that signed copies are on file with the company.</p></Dialog>}
  </div>;

  return <div className="space-y-6">
    <div className="flex justify-end"><Button variant="outline" onClick={() => setOne(true)}><Plus aria-hidden="true" className="size-4" />Add one person</Button></div>
    <Steps current={0} />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <Card><CardHeader title="Upload your list" description="For people already working here, or who worked here before. Add MCs and teams first, in Admin › Lists and Dispatch › Teams. Nothing is saved until you confirm on the last step, and the file itself is never kept." />
        <CardBody className="space-y-4">
          <div className="rounded-md border border-dashed border-border-strong p-6 text-center">
            <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={event => { void pick(event.target.files?.[0]); event.target.value = ''; }} />
            <Button disabled={busy} onClick={() => input.current?.click()}><Upload aria-hidden="true" className="size-4" />{busy ? 'Checking…' : 'Choose a CSV file'}</Button>
            <p className="mt-2 text-[13px] text-muted-foreground">CSV · up to {MAX_ROWS} rows. One row per person. Use the template so the columns match.</p>
          </div>
          <Notice message={error} error /><PendingHint pending={busy} />
          <Button variant="outline" onClick={() => download('existing-dispatchers-template.csv', TEMPLATE)}><Download aria-hidden="true" className="size-4" />Download template</Button>
        </CardBody></Card>
      <Card><CardHeader title="What goes in the file" /><CardBody className="space-y-3">
        <DescriptionList layout="rows" stacked items={[{ label: 'Name', value: 'First and last name, as they use it at work' }, { label: 'Position', value: 'Dispatcher, Support or Updater' }, { label: 'Where they work', value: 'Job title, and MC and team if you know them. A team brings its MC. A support or updater names their dispatcher instead, or just a team if they assist everyone on it. For someone who left: where they last worked, and job title only if you know it' },
          { label: 'Status', value: 'Active, or Left for someone who already left. Blank means Active. For someone on leave, use Active and put them on leave from their page' }, { label: 'Left on and reason', value: 'Their last day and a short reason, for people who left. Either can be blank. No health or private details' },
          { label: 'Legal name', value: 'Legal first and last name, if you know them' }, { label: 'Other names', value: 'Any other American names they used, here or at another of our companies, separated by ;' },
          { label: 'Started on', value: 'Their start date here, if you know it. You can add it on their page later' }, { label: 'Accounts', value: 'Company email, RingCentral number and extension, and DAT and Truckstop sign-in emails, if you know them. Never a password' }, { label: 'Contact', value: 'Personal email and phone, and Telegram, if you know them. The catch-up link needs the email' },
          { label: 'NDA and SOP', value: 'The date signed on paper. Leave it empty and they sign in the workspace' }]} />
        <p className="text-[13px] text-muted-foreground">No SSNs, ID numbers, birth dates or pay.</p></CardBody></Card>
    </div>
    {one && <AddOne options={options} onClose={() => setOne(false)} onAdded={(id, left) => { toast({ title: 'Dispatcher added', description: left ? 'Added as Left. Nobody was messaged.' : 'They’re Active now. Nobody was messaged.' }); router.push(`/dispatch/dispatchers/${id}`); }} />}
  </div>;
}

/**
 * One person at a time, with the same rules as the file (AddOneNamesScreen, AddOneLeftScreen): someone working here now, or
 * someone who already left, with their legal and other names. Nobody is messaged and IT isn't asked to do anything.
 */
function AddOne({ options, onClose, onAdded }: { options: ExistingOptions; onClose: () => void; onAdded: (id: string, left: boolean) => void }) {
  const [here, setHere] = useState('here'), [position, setPosition] = useState('Dispatcher'), [assisting, setAssisting] = useState('DISPATCHER'), [mc, setMc] = useState(''), [nda, setNda] = useState('SIGN'), [sop, setSop] = useState('SIGN');
  const [names, setNames] = useState<{ name: string; mcId: string }[]>([{ name: '', mcId: '' }]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [sameName, setSameName] = useState(false);
  const left = here === 'left', support = position !== 'Dispatcher';
  // Someone else's email or number (SharedMoveToOwnerScreen): asked as soon as it's typed, unless it's the same person by name.
  const [typed, setTyped] = useState({ firstName: '', lastName: '', companyEmail: '', ringCentralNumber: '' }), [sharedAction, setSharedAction] = useState<SharedAction | ''>('');
  const found = useAccountOwners(null, typed), fullName = `${typed.firstName} ${typed.lastName}`.trim().replace(/\s+/g, ' ').toLowerCase();
  const others = left ? [] : [...new Map([...found.companyEmail, ...found.ringCentralNumber].filter(owner => owner.name.toLowerCase() !== fullName).map(owner => [owner.id, owner])).values()];
  const holder = others[0] ?? null, holderFields = holder ? [...(found.companyEmail.some(item => item.id === holder.id) ? ['companyEmail'] : []), ...(found.ringCentralNumber.some(item => item.id === holder.id) ? ['ringCentralNumber'] : [])] : [];
  const movable = !!holder && [...found.companyEmail, ...found.ringCentralNumber].filter(item => item.id === holder.id).every(item => item.onRecord);
  const typing = (field: keyof typeof typed) => (event: React.ChangeEvent<HTMLInputElement>) => { const value = event.target.value; setTyped(current => ({ ...current, [field]: value })); if (field === 'companyEmail' || field === 'ringCentralNumber') setSharedAction(''); };
  // Section 44: one that was someone's who left (and nobody holds now) needs IT's confirmation.
  // The values as typed: a tick, or what the API said about them, holds only while they stay the same.
  const typedKey = `${typed.companyEmail.trim().toLowerCase()}|${typed.ringCentralNumber.trim()}`;
  const [checkedPrevious, setCheckedPrevious] = useState<{ key: string; items: PreviousOwnerItem[] } | null>(null), [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const lookedUp: PreviousOwnerItem[] = [...(found.former.companyEmail[0] ? [{ kind: 'EMAIL' as const, former: found.former.companyEmail[0] }] : []), ...(found.former.ringCentralNumber[0] ? [{ kind: 'RINGCENTRAL' as const, former: found.former.ringCentralNumber[0] }] : [])];
  // Added before the lookup answered: the API's answer names them instead.
  const formerItems = lookedUp.length ? lookedUp : checkedPrevious?.key === typedKey ? checkedPrevious.items : [], former = formerItems.length > 0;
  const formerConfirmed = confirmedFor === typedKey, setFormerConfirmed = (value: boolean) => setConfirmedFor(value ? typedKey : null);
  const them = holderFields.length > 1 ? 'them' : 'it', person = typed.firstName.trim() || 'this person', holderFirst = holder?.name.split(' ')[0] ?? '';
  // Someone who left may have last worked at an MC or team archived since.
  const allMcs = [...options.mcs.map(item => ({ ...item, archived: false })), ...(options.archivedMcs ?? []).map(item => ({ ...item, archived: true }))];
  const mcList = left ? allMcs : allMcs.filter(item => !item.archived), chosenMc = mcList.find(item => item.name === mc);
  const teams = [...options.teams.map(item => ({ ...item, archived: false })), ...(left ? (options.archivedTeams ?? []).map(item => ({ ...item, lead: null, archived: true })) : [])].filter(item => item.mcId === chosenMc?.id);
  const mcLabel = (item: { name: string; archived: boolean }) => item.archived ? `${item.name} (archived)` : item.name;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const data = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
    const differentPerson = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('name') === 'differentPerson';
    if (holder && !sharedAction) { setError(`Say whose the ${fieldsWord(holderFields)} ${holderFields.length > 1 ? 'are' : 'is'}.`); return; }
    if (former && !formerConfirmed) { setError(`Check with IT, then tick that it’s ${person}’s now, or change it.`); return; }
    setBusy(true); setError(''); setSameName(false);
    try {
      const where = support ? (left ? {} : assisting === 'TEAM' ? { supportsTeamId: data.supportsTeam } : { supportsMemberId: data.supports }) : { mc: mc === NO_MC ? '' : mc, team: data.team ?? '', jobTitle: data.jobTitle ?? '' };
      const row: ExistingRow = { row: 1, firstName: data.firstName, lastName: data.lastName, position, startedOn: data.startedOn, companyEmail: data.companyEmail, ringCentralNumber: data.ringCentralNumber, personalEmail: data.personalEmail, personalPhone: data.personalPhone,
        ringCentralExtension: data.ringCentralExtension, datEmail: data.datEmail, truckstopEmail: data.truckstopEmail, telegram: data.telegram, legalFirstName: data.legalFirstName, legalLastName: data.legalLastName,
        otherNameList: names.filter(item => item.name.trim()).map(item => ({ name: item.name.trim(), ...(item.mcId ? { mcId: item.mcId } : {}) })), ...where,
        ...(left ? { status: 'Left', leftOn: data.leftOn, leftReason: data.leftReason } : { ...(nda === 'PAPER' ? { ndaSignedOn: data.ndaSignedOn } : {}), ...(sop === 'PAPER' ? { sopSignedOn: data.sopSignedOn } : {}) }), ...(differentPerson ? { differentPerson } : {}), ...(holder && sharedAction ? { sharedAction } : {}), ...(former && formerConfirmed ? { previousOwnerAction: 'CONFIRMED' as const } : {}) };
      const result = await mutate<Added>('dispatch/existing/add', 'POST', { rows: [row] });
      if (result.members[0]) onAdded(result.members[0].id, left);
      else {
        const skipped = result.left[0], previous = !formerConfirmed && !skipped?.problems.length ? skipped?.previous ?? null : null;
        if (previous?.length) {
          // It waits for IT's confirmation of an email or number someone who left had: say so, with the tick.
          setCheckedPrevious({ key: typedKey, items: previous.map(item => ({ kind: item.field === 'companyEmail' ? 'EMAIL' as const : 'RINGCENTRAL' as const, former: { id: '', name: item.name, until: item.until } })) });
          setError(`Check with IT, then tick that it’s ${person}’s now, or change it.`);
        } else setError(skipped?.problems.join(' ') || 'Check the MC, team and job title against the lists.');
        setSameName(!!skipped?.sameName);
      }
    } catch (failure) { setError(errorMessage(failure, 'Unable to add them. Your entries have been kept.')); }
    finally { setBusy(false); }
  }
  const paper = [{ value: 'PAPER', label: 'Signed on paper' }, { value: 'SIGN', label: 'Sign in the workspace' }];
  const usedAt = [{ value: '', label: 'Not known' }, ...allMcs.map(item => ({ value: item.id, label: mcLabel(item) }))];
  const change = (index: number, value: Partial<{ name: string; mcId: string }>) => setNames(list => list.map((item, at) => at === index ? { ...item, ...value } : item));
  return <Dialog open onClose={onClose} busy={busy} size="lg" title="Add one existing dispatcher" description={left ? 'Added as Left: nobody is messaged, they get no sign-in, and IT isn’t asked to do anything.' : 'They become Active straight away. Nobody is messaged, and IT isn’t asked to set anything up.'}
    actions={<Button form="add-existing" type="submit" disabled={busy}><Plus aria-hidden="true" className="size-4" />{busy ? 'Adding…' : left ? 'Add as Left' : 'Add dispatcher'}</Button>}>
    <form id="add-existing" onSubmit={submit} className="space-y-5"><fieldset disabled={busy} className="min-w-0 space-y-5">
      <div className="grid gap-4 sm:grid-cols-2"><Input name="firstName" label="First name" hint="As they use it at work." required maxLength={100} width="full" onChange={typing('firstName')} /><Input name="lastName" label="Last name" hint="As they use it at work." required maxLength={100} width="full" onChange={typing('lastName')} /></div>
      <RadioGroup name="here" label="Do they work here now?" cards value={here} onChange={value => { setHere(value); setMc(''); }} options={[{ value: 'here', label: 'Yes, they work here', description: 'Added as Active.' }, { value: 'left', label: 'No, they already left', description: 'Added as Left, kept for the future: for example to know them if they come back.' }]} />
      {left ? <>
        <div className="grid gap-4 sm:grid-cols-2"><Input name="leftOn" label="Last day" optional type="date" width="full" hint="Leave empty if you don’t know. Add it later from their page." /><Input name="startedOn" label="Started on" optional type="date" width="full" /></div>
        <Textarea name="leftReason" label="Why they left" optional maxLength={500} rows={2} hint="Staff only. Never health, family or other private details." />
        <Select name="position" label="Position" value={position} onChange={event => setPosition(event.target.value)} options={['Dispatcher', 'Support', 'Updater']} width="sm" />
        {!support && <><div className="grid gap-4 sm:grid-cols-2"><Select name="mc" label="Last MC" optional value={mc} width="full" onChange={event => setMc(event.target.value)} options={[{ value: '', label: 'Not known' }, ...mcList.map(item => ({ value: item.name, label: mcLabel(item) }))]} />
          <Select name="team" label="Last team" optional width="full" disabled={!chosenMc} options={[{ value: '', label: 'Not known' }, ...teams.map(item => ({ value: item.name, label: mcLabel(item) }))]} /></div>
          <Select name="jobTitle" label="Job title" optional options={[{ value: '', label: 'Not known' }, ...options.jobTitles.map(item => ({ value: item.name, label: item.name }))]} /></>}
      </> : <>
        <div className="grid gap-4 sm:grid-cols-2"><Select name="position" label="Position" value={position} onChange={event => setPosition(event.target.value)} options={['Dispatcher', 'Support', 'Updater']} width="full" /><Input name="startedOn" label="Started on" optional type="date" width="full" hint="If you don’t know it, add it on their page later." /></div>
        {support ? <><RadioGroup name="assisting" label="They assist" value={assisting} onChange={setAssisting} options={[{ value: 'DISPATCHER', label: 'One dispatcher' }, { value: 'TEAM', label: 'A whole team', description: 'Everyone on the team, with no one dispatcher.' }]} />
          {assisting === 'TEAM' ? <Select name="supportsTeam" label="Team" required placeholder="Choose a team" width="full" options={options.teams.map(item => ({ value: item.id, label: [item.name, options.mcs.find(mcItem => mcItem.id === item.mcId)?.name].filter(Boolean).join(' · ') }))} hint="They work where the team works." />
            : <Select name="supports" label="Dispatcher they assist" required placeholder="Choose a dispatcher" width="full" options={options.dispatchers.map(item => ({ value: item.id, label: item.mc ? `${item.name} · ${item.mc}` : item.name }))} hint="They work where their dispatcher works." />}</>
          : <><div className="grid gap-4 sm:grid-cols-2"><Select name="mc" label="MC" required value={mc} placeholder="Choose an MC" width="full" onChange={event => setMc(event.target.value)} options={[...options.mcs.map(item => ({ value: item.name, label: item.name })), { value: NO_MC, label: NO_MC }]} />
            <Select name="team" label="Team" width="full" required={!!chosenMc} placeholder={mc === NO_MC ? 'Set with their MC later' : mc ? 'Choose a team' : 'Choose an MC first'} disabled={!chosenMc}
              hint={chosenMc ? 'Independent: works for this MC, not in a team.' : undefined}
              options={chosenMc ? [{ value: INDEPENDENT, label: 'Independent (no team)' }, ...teams.map(item => ({ value: item.name, label: item.lead ? `${item.name} · ${item.lead}` : item.name }))] : []} /></div>
            <Select name="jobTitle" label="Job title" required placeholder="Choose a job title" options={options.jobTitles.map(item => ({ value: item.name, label: item.name }))} /></>}
      </>}
      <Card><CardHeader title="Names" description="So search finds them by any name they used." /><CardBody className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2"><Input name="legalFirstName" label="Legal first name" optional maxLength={100} width="full" /><Input name="legalLastName" label="Legal last name" optional maxLength={100} width="full" /></div>
        {names.map((item, index) => <div key={index} className="flex flex-wrap items-end gap-3">
          <Input label="Other name" optional value={item.name} maxLength={100} hint={index ? undefined : 'Another American name they use or used.'} onChange={event => change(index, { name: event.target.value })} width="full" className="min-w-0 flex-[2_1_200px]" />
          <Select label="Used at" optional value={item.mcId} onChange={event => change(index, { mcId: event.target.value })} options={usedAt} width="full" className="min-w-0 flex-[1_1_160px]" />
          {names.length > 1 && <Button type="button" size="sm" variant="ghost" onClick={() => setNames(list => list.filter((_, at) => at !== index))}><X aria-hidden="true" className="size-4" />Remove<span className="sr-only"> {item.name}</span></Button>}
        </div>)}
        <Button type="button" size="sm" variant="outline" disabled={names.length >= 10} onClick={() => setNames(list => [...list, { name: '', mcId: '' }])}><Plus aria-hidden="true" className="size-4" />Add another name</Button>
        <p className="text-[13px] text-muted-foreground">Latin letters only.</p>
      </CardBody></Card>
      <Card><CardHeader title="Accounts" description={left ? 'What they had, if you know it. Nothing is closed unless you ask IT later from their page.' : 'What you know now. IT uses these when they leave, so add them if you can.'} /><CardBody className="grid gap-4 sm:grid-cols-2"><Input name="companyEmail" label="Company email" optional type="email" maxLength={254} width="full" onChange={typing('companyEmail')} /><Input name="ringCentralNumber" label="RingCentral number" optional type="tel" maxLength={40} width="full" onChange={typing('ringCentralNumber')} />
        {holder && <div className="space-y-4 sm:col-span-2">
          <Alert tone="warning" title={`${holder.name} has this ${fieldsWord(holderFields)} on their record`}><p>{movable ? `If ${holderFields.length > 1 ? 'they’re' : 'it’s'} ${person}’s, move ${them}. Nothing is retyped and ${holderFirst}’s history keeps the change.` : 'It’s from IT’s records, so it can’t be moved here.'}</p></Alert>
          <RadioGroup name="sharedAction" label={`Whose ${holderFields.length > 1 ? 'are they' : 'is it'}?`} cards value={sharedAction} onChange={value => setSharedAction(value as SharedAction)} options={[
            ...(movable ? [{ value: 'MOVE_SHARED', label: `${person}’s, and ${holderFirst} uses ${them} too`, description: `Move to ${person} and record ${holderFirst} as using ${them}, shared.` },
              { value: 'MOVE', label: `${person}’s, and ${holderFirst} doesn’t use ${them}`, description: `Move to ${person}. ${holderFirst}’s record is left without ${them}.` }] : []),
            { value: 'SHARED', label: `${holderFirst}’s, and ${person} uses ${them} too`, description: 'Recorded as shared: it stays where it is, and both pages say who else uses it.' },
            { value: 'WITHOUT', label: `${holderFirst}’s only`, description: `Leave ${them} with ${holderFirst} and add ${person} without ${them}.` }]} />
          <p className="text-[13px] text-muted-foreground">If they’re the same person, close this and use Correct details on {holderFirst}’s page instead.</p>
        </div>}
        <PreviousOwnerWarning firstName={person} items={formerItems} confirmed={formerConfirmed} onChange={setFormerConfirmed} />
        {!left && <><Input name="ringCentralExtension" label="Extension" optional inputMode="numeric" pattern="[0-9]{1,6}" maxLength={6} width="full" hint="Digits only." /><span className="max-sm:hidden" />
          <Input name="datEmail" label="DAT sign-in email" optional type="email" maxLength={254} width="full" hint="The email only. Never a password." /><Input name="truckstopEmail" label="Truckstop sign-in email" optional type="email" maxLength={254} width="full" hint="The email only. Never a password." /></>}</CardBody></Card>
      <Card><CardHeader title="Contact" description={left ? undefined : 'The catch-up link is checked against the personal email.'} /><CardBody className="grid gap-4 sm:grid-cols-2"><Input name="personalEmail" label="Personal email" optional type="email" maxLength={254} width="full" /><Input name="personalPhone" label="Personal phone" optional type="tel" maxLength={40} width="full" />{!left && <Input name="telegram" label="Telegram" optional maxLength={100} width="full" autoComplete="off" />}</CardBody></Card>
      {!left && <Card><CardHeader title="Signed documents" description="A date confirms that a signed paper copy is on file with the company." /><CardBody className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3"><Select label="NDA" value={nda} onChange={event => setNda(event.target.value)} options={paper} width="full" />{nda === 'PAPER' && <Input name="ndaSignedOn" label="NDA signed on" type="date" required width="full" />}</div>
        <div className="space-y-3"><Select label="SOP" value={sop} onChange={event => setSop(event.target.value)} options={paper} width="full" />{sop === 'PAPER' && <Input name="sopSignedOn" label="SOP signed on" type="date" required width="full" />}</div></CardBody></Card>}
      <Notice message={error} error />{sameName && <Button type="submit" name="differentPerson" variant="outline" size="sm">They’re different people, add them</Button>}<PendingHint pending={busy} />
    </fieldset></form>
  </Dialog>;
}
