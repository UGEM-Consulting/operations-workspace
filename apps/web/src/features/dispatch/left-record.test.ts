import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { itNotAsked, lastWorked } from './left-record.ts';

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
