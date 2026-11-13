import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_COLUMNS, membersCsv, type ExportRow } from './members-csv.ts';

const row = (extra: Partial<ExportRow>): ExportRow => ({ id: '1', firstName: 'Riley', lastName: 'Santos', position: 'DISPATCHER', status: 'ACTIVE', version: 1, joinedAt: '2024-03-04T12:00:00.000Z', leftAt: null,
  jobTitle: 'Dispatcher', since: '2024-03-04T12:00:00.000Z', mc: 'Northwind Freight', teamId: null, team: 'Avery team', lead: false, ...extra });
const lines = (rows: ExportRow[]) => membersCsv(rows).split('\r\n');

describe('the Dispatchers export', () => {
  it('writes work details in a fixed column order, with a Telegram @ kept as text', () => {
    const [heading, first] = lines([row({ teamLead: 'Jordan Avery', companyEmail: 'riley@example.test', ringCentralNumber: '+1 469 555 0142', ringCentralExtension: '130', telegram: 'riley_disp' })]);
    assert.equal(heading, EXPORT_COLUMNS.join(','));
    assert.equal(first, "Riley Santos,Dispatcher,Northwind Freight,Avery team,Jordan Avery,Dispatcher,2024-03-04,Active,,riley@example.test,+1 469 555 0142,130,'@riley_disp");
  });
  it('names supports and updaters, leaves their job title empty and says who is leaving or away', () => {
    const [, updater, away] = lines([row({ position: 'SUPPORT', supportType: 'UPDATER', jobTitle: null, lastDay: '2026-12-01' }),
      row({ sinceKnown: false, leave: { firstDay: '2026-11-01', backOn: '2026-12-01', started: true, it: 'NONE' } })]);
    assert.match(updater, /^Riley Santos,Updater,Northwind Freight,Avery team,,,2024-03-04,Leaving,2026-12-01,/);
    assert.match(away, /^Riley Santos,Dispatcher,Northwind Freight,Avery team,,Dispatcher,,On leave,,/);
  });
  it('never lets a spreadsheet run a cell as a formula, and quotes commas', () => {
    const [, line] = lines([row({ firstName: '=HYPERLINK("x")', team: 'Avery, North' })]);
    assert.ok(line.startsWith(`"'=HYPERLINK(""x"") Santos"`));
    assert.ok(line.includes('"Avery, North"'));
  });
});
