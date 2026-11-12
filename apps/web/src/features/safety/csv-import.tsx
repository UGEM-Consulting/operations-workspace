'use client';
import { useRef, useState } from 'react';
import { ArrowLeft, Download, Plus, Upload } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Person } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { PendingHint } from '@/components/ui/pending-hint';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { errorMessage, mutate } from '@/lib/client-api';
import { parseRows } from '@/features/dispatch/existing-csv';

/** A row as the API takes it: its spreadsheet row number and its cells by field, as text. */
export type CsvRow = { row: number } & Record<string, string | number | boolean | undefined>;
type Status = 'READY' | 'CHOICE' | 'PROBLEM' | 'ALREADY';
export interface CheckedRow { row: number; name: string; detail: string; status: Status; problems: string[]; notes?: string[]; onHold?: boolean }
export interface Checked { rows: CheckedRow[]; choices: { field: string; text: string; rows: number[]; options: { value: string; label: string }[] }[];
  counts: { ready: number; choice: number; problem: number; already: number; onHold?: number } }
export interface Added { added: number; left: CheckedRow[] }
export interface ImportSetup {
  /** Columns in the file, in template order: the heading and the field it fills. */
  columns: readonly (readonly [string, string])[]; optional?: readonly string[]; template: Record<string, string>[];
  /** What a row is (unit, driver), for counts and buttons. */
  noun: [string, string]; steps: [string, string, string]; check: string; add: string; templateName: string;
  choiceLabels: Record<string, [string, string]>; guide: { label: string; value: string }[]; guideNote: string; uploadNote: string; addNote: string;
  /** What happens once they're added, under the upload card. */ next?: string[];
}
export const MAX_ROWS = 500;
const key = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, '_');
/** A spreadsheet would run a cell starting with these as a formula; a phone's leading + is left alone. */
function cell(value: string) {
  const safe = /^[=@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export function toCsv(columns: ImportSetup['columns'], rows: Record<string, unknown>[]) {
  return [columns.map(([name]) => name).join(','), ...rows.map(row => columns.map(([, field]) => cell(String(row[field] ?? ''))).join(','))].join('\r\n') + '\r\n';
}
/** The rows in a file. Row numbers are the spreadsheet's, counting the heading as row 1, so they can be found in the file. */
export function readCsvFile(text: string, columns: ImportSetup['columns'], optional: readonly string[] = []): { rows: CsvRow[]; error?: undefined } | { rows?: undefined; error: string } {
  const [heading, ...lines] = parseRows(text);
  if (!heading) return { error: 'This file is empty.' };
  const positions = heading.cells.map(key), missing = columns.map(([name]) => name).filter(name => !positions.includes(name) && !optional.includes(name));
  if (missing.length) return { error: `This file is missing these columns: ${missing.join(', ')}. Use the template.` };
  if (!lines.length) return { error: 'This file has a heading but no rows.' };
  if (lines.length > MAX_ROWS) return { error: `This file has ${lines.length} rows. Upload up to ${MAX_ROWS} at a time.` };
  return { rows: lines.map(({ number, cells }) => {
    const row: CsvRow = { row: number };
    for (const [name, field] of columns) { const value = positions.includes(name) ? cells[positions.indexOf(name)]?.trim() : ''; if (value) row[field] = value.slice(0, 300); }
    return row;
  }) };
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
function Steps({ steps, current }: { steps: readonly string[]; current: number }) {
  return <ol className="grid gap-2 sm:grid-cols-3" aria-label="Steps">{steps.map((label, index) => <li key={label} aria-current={index === current ? 'step' : undefined}
    className={`rounded-md border px-3 py-2 text-xs ${index === current ? 'border-primary bg-brand-subtle font-semibold text-brand-subtle-foreground' : 'border-border text-muted-foreground'}`}>{index + 1}. {label}</li>)}</ol>;
}
function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return <div className="rounded-lg border bg-card p-4 shadow-xs"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>{hint && <p className="text-[13px] text-muted-foreground">{hint}</p>}</div>;
}
const tones: Record<Status, 'danger' | 'neutral' | 'warning' | 'success'> = { PROBLEM: 'danger', ALREADY: 'neutral', CHOICE: 'warning', READY: 'success' };
const labels: Record<Status, string> = { PROBLEM: 'Problem', ALREADY: 'Already here', CHOICE: 'Needs a choice', READY: 'Ready' };
const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Safety's imports from a file (units, existing drivers): upload, check the rows, add. The browser reads the CSV; only its rows
 * go to the API, which checks them and keeps the records, never the file. One choice fixes every row with that text: its value
 * goes in those rows' column and the rows are checked again.
 */
export function CsvImport({ setup, done, addOne }: { setup: ImportSetup; done: (result: Added, again: () => void) => React.ReactNode; addOne?: React.ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState(''), [rows, setRows] = useState<CsvRow[]>([]), [checked, setChecked] = useState<Checked | null>(null), [result, setResult] = useState<Added | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [adding, setAdding] = useState(false);
  const [one, many] = setup.noun, count = (n: number) => `${n} ${n === 1 ? one : many}`;
  async function check(next: CsvRow[]) {
    setBusy(true); setError('');
    try { setChecked(await mutate<Checked>(setup.check, 'POST', { rows: next })); setRows(next); }
    catch (failure) { setError(errorMessage(failure, 'Unable to check the rows. Your file hasn’t been saved.')); }
    finally { setBusy(false); }
  }
  async function pick(file: File | undefined) {
    if (!file) return;
    if (file.size > 900_000) { setError(`This file is too large. Upload up to ${MAX_ROWS} rows at a time.`); return; }
    const read = readCsvFile(await file.text(), setup.columns, setup.optional);
    if (read.error !== undefined) { setError(read.error); return; }
    setFileName(file.name); await check(read.rows);
  }
  function choose(choice: Checked['choices'][number], value: string) {
    if (value) void check(rows.map(row => choice.rows.includes(row.row) ? { ...row, [choice.field]: value } : row));
  }
  async function add() {
    setBusy(true); setError('');
    try { setResult(await mutate<Added>(setup.add, 'POST', { rows, sourceName: fileName || undefined })); setAdding(false); }
    catch (failure) { setError(errorMessage(failure, 'Unable to add them. Nothing was saved.')); setAdding(false); }
    finally { setBusy(false); }
  }
  const again = () => { setResult(null); setChecked(null); setRows([]); setFileName(''); };
  if (result) return <div className="space-y-6">
    <Steps steps={setup.steps} current={2} />
    {done(result, again)}
    {result.left.length > 0 && <Card><CardHeader title={`${result.left.length} ${result.left.length === 1 ? 'row' : 'rows'} left out`} description="Correct these and upload them again. Rows already added show as Already here." />
      <Table className="mt-3 border-t border-border" caption="Rows left out" rows={result.left} rowKey={row => String(row.row)} columns={[{ key: 'row', label: 'Row', nowrap: true, cell: row => row.row },
        { key: 'name', label: capital(one), primary: true, cell: row => row.name }, { key: 'why', label: 'Why', cell: row => row.problems.join(' ') || 'It still needs a choice.' }]} /></Card>}
  </div>;
  if (checked) {
    const lookAt = checked.rows.filter(row => row.status !== 'READY' || row.notes?.length);
    const leftOut = rows.filter(row => checked.rows.some(item => item.row === row.row && item.status !== 'READY'));
    return <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{fileName ? `${fileName}, ` : ''}{checked.rows.length} {checked.rows.length === 1 ? 'row' : 'rows'}. Nothing is saved yet.</p>
      <Steps steps={setup.steps} current={1} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4"><Stat label="Ready to add" value={checked.counts.ready} hint={checked.counts.onHold ? `${checked.counts.onHold} of them will be on hold` : undefined} />
        <Stat label="Need a choice" value={checked.counts.choice} /><Stat label="Have a problem" value={checked.counts.problem} /><Stat label="Already here" value={checked.counts.already} /></div>
      {checked.choices.length > 0 && <Card><CardHeader title="Choose what these mean" description="Each choice fixes every row with that text." />
        <ul className="mt-3 divide-y divide-border border-t border-border">{checked.choices.map(choice => {
          const [what, use] = setup.choiceLabels[choice.field] ?? [capital(choice.field), 'Use this'];
          return <li key={`${choice.field}-${choice.text}`} className="flex flex-wrap items-end justify-between gap-3 px-4 py-3 sm:px-5">
            <div className="min-w-0 flex-[1_1_240px]"><p className="text-sm font-medium">{what} “{choice.text}”</p><p className="text-[13px] text-muted-foreground">{choice.rows.length} {choice.rows.length === 1 ? 'row' : 'rows'}</p></div>
            <Select label={use} value="" placeholder="Choose" options={choice.options} disabled={busy} width="md" onChange={event => choose(choice, event.target.value)} />
          </li>;
        })}</ul></Card>}
      {lookAt.length > 0 && <Card><CardHeader title="Rows to look at" actions={leftOut.length > 0 && <Button size="sm" variant="outline" onClick={() => download('rows-to-correct.csv', toCsv(setup.columns, leftOut))}><Download aria-hidden="true" className="size-4" />Download these rows</Button>} />
        <Table className="mt-3 border-t border-border" caption="Rows with a problem, a note or already recorded" rows={lookAt} rowKey={row => String(row.row)} columns={[
          { key: 'row', label: 'Row', nowrap: true, cell: row => row.row },
          { key: 'name', label: capital(one), primary: true, cell: row => <Person name={row.name} secondary={row.detail} /> },
          { key: 'why', label: 'What to know', cell: row => [...row.problems, ...(row.status === 'ALREADY' ? [] : row.notes ?? [])].join(' ') || 'It needs a choice above.' },
          { key: 'status', label: 'Status', cell: row => row.status === 'READY' && row.onHold ? <Badge label="On hold" tone="warning" /> : <Badge label={labels[row.status]} tone={tones[row.status]} /> }]} /></Card>}
      {(checked.counts.choice > 0 || checked.counts.problem > 0) && <Alert tone="info" title="You don’t have to fix everything now"><p>Add the rows that are ready, then correct the others and upload them again. A row already added shows as Already here.</p></Alert>}
      <Notice message={error} error /><PendingHint pending={busy} />
      <div className="flex flex-wrap justify-between gap-3"><Button variant="ghost" disabled={busy} onClick={() => { setChecked(null); setRows([]); setError(''); }}><ArrowLeft aria-hidden="true" className="size-4" />Upload a different file</Button>
        <Button disabled={busy || !checked.counts.ready} onClick={() => setAdding(true)}><Plus aria-hidden="true" className="size-4" />Add {count(checked.counts.ready)}</Button></div>
      {adding && <Dialog open onClose={() => setAdding(false)} busy={busy} title={`Add ${count(checked.counts.ready)}?`} description={setup.addNote}
        actions={<Button disabled={busy} onClick={() => void add()}>{busy ? 'Adding…' : 'Add them'}</Button>}><PendingHint pending={busy} /><p className="text-sm text-muted-foreground">Rows that aren’t ready are left out.</p></Dialog>}
    </div>;
  }
  return <div className="space-y-6">
    {addOne}
    <Steps steps={setup.steps} current={0} />
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
      <Card><CardHeader title="Upload your list" description={setup.uploadNote} />
        <CardBody className="space-y-4">
          <div className="rounded-md border border-dashed border-border-strong p-6 text-center">
            <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={event => { void pick(event.target.files?.[0]); event.target.value = ''; }} />
            <Button disabled={busy} onClick={() => input.current?.click()}><Upload aria-hidden="true" className="size-4" />{busy ? 'Checking…' : 'Choose a CSV file'}</Button>
            <p className="mt-2 text-[13px] text-muted-foreground">CSV · up to {MAX_ROWS} rows. One row per {one}. Use the template so the columns match.</p>
          </div>
          <Notice message={error} error /><PendingHint pending={busy} />
          <Button variant="outline" onClick={() => download(setup.templateName, toCsv(setup.columns, setup.template))}><Download aria-hidden="true" className="size-4" />Download template</Button>
        </CardBody></Card>
      {setup.next && <Card className="xl:col-start-1"><CardHeader title="What happens next" /><CardBody><ul className="list-disc space-y-1.5 pl-5 text-sm">{setup.next.map(item => <li key={item}>{item}</li>)}</ul></CardBody></Card>}
      <Card><CardHeader title="What goes in the file" /><CardBody className="space-y-3">
        <DescriptionList layout="rows" stacked items={setup.guide} />
        <p className="text-[13px] text-muted-foreground">{setup.guideNote}</p></CardBody></Card>
    </div>
  </div>;
}
