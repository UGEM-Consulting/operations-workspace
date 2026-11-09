import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchDriverOptionsSchema, teamViewSchema } from './api-schemas.ts';

describe('dispatch responses', () => {
  it('accepts an independent dispatcher (no team) among the people a driver can be assigned to', () => {
    const options = { mcs: [{ id: 'mc', name: 'Stage Carriers', dispatchers: [{ id: 'a', name: 'Avery Stage', team: 'Stage Red' }, { id: 'c', name: 'Casey Stage', team: null }] }] };
    assert.equal(dispatchDriverOptionsSchema.safeParse(options).success, true);
  });
  it('reads a team lead’s team with or without who is leaving and whose paperwork is accepted', () => {
    const base = { teams: [{ id: 't', name: 'Stage Red', mc: 'Stage Freight' }], requests: [] };
    const older = { ...base, dispatchers: [{ id: 'a', name: 'Avery Stage', status: 'ACTIVE', teamId: 't', lead: true }],
      supports: [{ id: 's', name: 'Emery Stage', status: 'ACTIVE', dispatcherId: 'a', since: '2025-05-05T12:00:00Z', pending: null }] };
    const newer = { ...base, dispatchers: [{ ...older.dispatchers[0], lastDay: '2026-11-23' }], supports: [{ ...older.supports[0], lastDay: null, hasApplication: false }] };
    assert.equal(teamViewSchema.safeParse(older).success, true);
    assert.equal(teamViewSchema.safeParse(newer).success, true);
  });
});
