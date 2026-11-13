/** One person from the file or the form, as the API takes it: text, checked by the API row by row. */
export interface ExistingRow {
  row: number; firstName?: string; lastName?: string; position?: string; mc?: string; team?: string; jobTitle?: string; startedOn?: string; companyEmail?: string; ringCentralNumber?: string;
  personalEmail?: string; personalPhone?: string; supports?: string; supportsMemberId?: string; supportsTeamId?: string; ndaSignedOn?: string; sopSignedOn?: string; differentPerson?: boolean;
  telegram?: string; ringCentralExtension?: string; datEmail?: string; truckstopEmail?: string;
  // The load board account each sign-in is on, by its name in Admin › Lists (section 33).
  datAccount?: string; truckstopAccount?: string;
  // People who left and other names (section 33). askIt and alreadyAction are choices made on the check step, never columns.
  status?: string; leftOn?: string; leftReason?: string; legalFirstName?: string; legalLastName?: string; otherNames?: string; askIt?: boolean; alreadyAction?: 'FILL' | 'CAME_BACK' | 'ACCOUNT';
}
type Field = Exclude<keyof ExistingRow, 'row' | 'differentPerson' | 'supportsMemberId' | 'supportsTeamId' | 'askIt' | 'alreadyAction'>;
export const COLUMNS: readonly [string, Field][] = [['first_name', 'firstName'], ['last_name', 'lastName'], ['position', 'position'], ['mc', 'mc'], ['team', 'team'], ['job_title', 'jobTitle'], ['started_on', 'startedOn'],
  ['company_email', 'companyEmail'], ['ringcentral_number', 'ringCentralNumber'], ['personal_email', 'personalEmail'], ['personal_phone', 'personalPhone'], ['supports', 'supports'], ['nda_signed_on', 'ndaSignedOn'], ['sop_signed_on', 'sopSignedOn'], ['telegram', 'telegram'], ['ringcentral_ext', 'ringCentralExtension'], ['dat_email', 'datEmail'], ['truckstop_email', 'truckstopEmail'],
  ['dat_account', 'datAccount'], ['truckstop_account', 'truckstopAccount'],
  ['status', 'status'], ['left_on', 'leftOn'], ['left_reason', 'leftReason'], ['legal_first_name', 'legalFirstName'], ['legal_last_name', 'legalLastName'], ['other_names', 'otherNames']];
// Added later, so an older file without them still works.
const OPTIONAL_COLUMNS = ['telegram', 'ringcentral_ext', 'dat_email', 'truckstop_email', 'dat_account', 'truckstop_account', 'status', 'left_on', 'left_reason', 'legal_first_name', 'legal_last_name', 'other_names'];
export const MAX_ROWS = 500;

/** Reads CSV text: quoted fields, doubled quotes, commas and line breaks inside quotes, and CRLF line endings. */
export function parseCsv(text: string): string[][] {
  return parseRows(text).map(row => row.cells);
}
/** The rows with something in them, each with its spreadsheet row number: blank rows count, and a line break inside quotes stays in its row. */
export function parseRows(text: string): { number: number; cells: string[] }[] {
  const rows: { number: number; cells: string[] }[] = [];
  let row: string[] = [], field = '', quoted = false, number = 0;
  const finish = () => { row.push(field); field = ''; number += 1; if (row.some(cell => cell.trim())) rows.push({ number, cells: row }); row = []; };
  const source = text.replace(/^﻿/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && !field) quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      finish();
    } else field += char;
  }
  finish();
  return rows;
}
const key = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** The people in a file. Row numbers are the spreadsheet's, counting the heading as row 1, so they can be found in the file. */
export function readExistingFile(text: string): { rows: ExistingRow[]; error?: undefined } | { rows?: undefined; error: string } {
  const [heading, ...lines] = parseRows(text);
  if (!heading) return { error: 'This file is empty.' };
  const positions = heading.cells.map(key), missing = COLUMNS.map(([name]) => name).filter(name => !positions.includes(name) && !OPTIONAL_COLUMNS.includes(name));
  if (missing.length) return { error: `This file is missing these columns: ${missing.join(', ')}. Use the template.` };
  if (!lines.length) return { error: 'This file has a heading but no people.' };
  if (lines.length > MAX_ROWS) return { error: `This file has ${lines.length} rows. Upload up to ${MAX_ROWS} at a time.` };
  return { rows: lines.map(({ number, cells }) => {
    const row: ExistingRow = { row: number };
    for (const [name, field] of COLUMNS) { const cell = positions.includes(name) ? cells[positions.indexOf(name)]?.trim() : ''; if (cell) row[field] = cell.slice(0, 300); }
    return row;
  }) };
}
/** A spreadsheet would run a cell starting with these as a formula; a phone's leading + is left alone. */
export function csvCell(value: string) {
  const safe = /^[=@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export function existingCsv(rows: ExistingRow[]) {
  return [COLUMNS.map(([name]) => name).join(','), ...rows.map(row => COLUMNS.map(([, field]) => csvCell(row[field] ?? '')).join(','))].join('\r\n') + '\r\n';
}
export const TEMPLATE = existingCsv([
  { row: 2, firstName: 'Riley', lastName: 'Santos', position: 'Dispatcher', mc: 'Northwind Freight', team: 'Avery team', jobTitle: 'Dispatcher', startedOn: '2024-03-04', companyEmail: 'riley.santos@example.test', ringCentralNumber: '+1 469 555 0142', personalEmail: 'riley.home@example.test', personalPhone: '+1 202 555 0147', ndaSignedOn: '2024-03-04' },
  { row: 3, firstName: 'Sky', lastName: 'Martin', position: 'Support', startedOn: '2025-01-13', personalEmail: 'sky.home@example.test', supports: 'Riley Santos' },
  { row: 4, firstName: 'Alex', lastName: 'Moreno', position: 'Updater', team: 'Avery team', personalEmail: 'alex.home@example.test', otherNames: 'Alex Moore' },
  { row: 5, firstName: 'Drew', lastName: 'Calloway', position: 'Dispatcher', mc: 'Northwind Freight', jobTitle: 'Dispatcher', startedOn: '2023-06-02', status: 'Left', leftOn: '2025-08-15', leftReason: 'Moved to another company.', legalFirstName: 'Andrew', legalLastName: 'Calloway', companyEmail: 'drew.calloway@example.test' }]);
