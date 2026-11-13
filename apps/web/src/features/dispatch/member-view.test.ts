import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeView, matchedRange } from './member-view.ts';
import type { MemberOptions } from './types.ts';

const options: MemberOptions = { mcs: [{ id: 'm1', name: 'Northwind Freight', archived: false }, { id: 'm2', name: 'Old Carriers', archived: true }], teams: [{ id: 't1', name: 'Avery team', mcId: 'm1', archived: false }],
  leads: [{ id: 'l1', name: 'Jordan Avery' }], jobTitles: [] };
const marked = (value: string, search: string) => { const range = matchedRange(value, search); return range && value.slice(...range); };

describe('the Dispatchers view in words', () => {
  it('names the chosen MC, as the export dialog does (DispatchersExportScreen)', () => {
    assert.equal(describeView('Active', { mcId: 'm1', sort: '' }, options), 'Active · MC: Northwind Freight · sorted by name');
  });
  it('names every filter, the search and the sort', () => {
    assert.equal(describeView('All', { mcId: 'm2', teamId: 'NONE', leadId: 'l1', position: 'UPDATER', drivers: 'WITH', search: 'riley', sort: 'lead' }, options),
      'All · MC: Old Carriers (archived) · Team: Independent (no team) · Team lead: Jordan Avery · Position: Updater · Drivers: With drivers · search “riley” · sorted by team lead');
  });
});

describe('the matched part of a contact detail', () => {
  it('marks a number by its digits, whatever the separators either side', () => {
    assert.equal(marked('+1 469 253 3730', '253 3730'), '253 3730');
    assert.equal(marked('+1 469 253 3730', '(469) 253-3730'), '469 253 3730');
    assert.equal(marked('202 555 0102', '12025550102'), '202 555 0102');
  });
  it('marks text without regard to case, and a Telegram name with or without its @', () => {
    assert.equal(marked('Riley@Example.test', 'riley@example'), 'Riley@Example');
    assert.equal(marked('riley_disp', '@riley_disp'), 'riley_disp');
  });
  it('marks nothing when the detail doesn’t contain the search', () => {
    assert.equal(matchedRange('+1 469 253 3730', '999'), null);
    assert.equal(matchedRange('riley@example.test', ''), null);
  });
});
