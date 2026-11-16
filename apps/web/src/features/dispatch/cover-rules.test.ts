import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { coverAll, coversFor, everyoneValue, startingChoices } from './cover-rules.ts';

const driver = (id: string, mcId = 'nw', coverId: string | null = null) => ({ id, name: id, truck: null, mcId, mc: mcId, coverId });
const dispatcher = (id: string, mcId = 'nw') => ({ id, name: id, mcId, team: null });

describe('who covers drivers while their dispatcher is away', () => {
  it('starts with one dispatcher for everyone when all the drivers are on one MC', () => {
    const options = { drivers: [driver('marcus'), driver('lena')], dispatchers: [dispatcher('jordan'), dispatcher('sky')] };
    assert.deepEqual(startingChoices(options), { marcus: 'jordan', lena: 'jordan' });
    assert.equal(everyoneValue(startingChoices(options)), 'jordan');
    assert.equal(everyoneValue({ marcus: 'jordan', lena: 'sky' }), 'MIXED');
  });
  it('offers each driver only dispatchers under their own MC, and no one for everyone across MCs', () => {
    const options = { drivers: [driver('marcus'), driver('ana', 'lc')], dispatchers: [dispatcher('jordan'), dispatcher('quinn', 'lc')] };
    assert.deepEqual(coverAll(options), []);
    assert.deepEqual(coversFor(options, options.drivers[1]).map(item => item.id), ['quinn']);
    assert.deepEqual(startingChoices(options), { marcus: '', ana: '' });
  });
  it('keeps who already covers a driver when the plan is changed', () => {
    const options = { drivers: [driver('marcus', 'nw', 'sky'), driver('lena')], dispatchers: [dispatcher('jordan'), dispatcher('sky')] };
    assert.deepEqual(startingChoices(options), { marcus: 'sky', lena: 'jordan' });
  });
});
