import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { itNotAsked, lastWorked, recordChangeItems } from './left-record.ts';

const period = (mc: string | null) => ({ id: 'p', mcId: mc ? 'm' : null, mc, teamId: null, team: null, startedAt: '2024-03-04T12:00:00.000Z', endedAt: '2025-06-30T12:00:00.000Z' });
describe('the page of someone who left', () => {
  it('says where they last worked, from the newest period', () => {
    assert.equal(lastWorked({ jobTitle: { id: 't', name: 'Senior dispatcher' }, history: [period('Lakeside Carriers'), period('Northwind Freight')] as never }), 'Senior dispatcher at Lakeside Carriers');
    assert.equal(lastWorked({ jobTitle: null, history: [period('Ozon')] as never }), 'Dispatcher at Ozon');
    // No MC recorded: never "No MC yet" for someone who left.
    assert.equal(lastWorked({ jobTitle: null, history: [period(null)] as never }), 'Dispatcher');
    assert.equal(lastWorked({ jobTitle: null, history: [] }), 'Dispatcher');
  });
  it('tells IT access apart when nothing was recorded', () => {
    assert.match(itNotAsked(true), /Ask only if their accounts might still be open/);
    assert.match(itNotAsked(false), /nothing for IT to close/);
  });
});
describe('changes to the record in History', () => {
  const change = (event: string, metadata: object) => ({ id: event, event, createdAt: '2026-11-20T15:00:00.000Z', by: 'Avery Quinn', metadata });
  it('names the file details were added from and what was added, never values', () => {
    const [item] = recordChangeItems([change('EXISTING_UPDATED', { fields: ['lastDay', 'leftReason', 'ringCentralNumber', 'otherNames'], from: 'file', source: 'lakeside-history-2.csv', otherNames: 1 })]);
    assert.equal(item.title, 'Details added from lakeside-history-2.csv');
    assert.equal(item.body, 'Last day, reason for leaving, RingCentral number, 1 other name.');
  });
  it('tells edits by hand and name changes apart', () => {
    const [edited, names] = recordChangeItems([change('EXISTING_UPDATED', { fields: ['companyEmail'] }), change('NAMES_CHANGED', { fields: ['legalName', 'otherNames'] })]);
    assert.equal(edited.title, 'Recorded details changed');
    assert.equal(edited.body, 'Company email.');
    assert.equal(names.title, 'Names changed');
    assert.equal(names.body, 'Legal name, other names.');
  });
});
