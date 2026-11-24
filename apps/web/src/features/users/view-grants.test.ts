import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chosenGrants, viewChoice, viewLabel } from './view-grants.ts';

describe('view-only departments in the staff account dialog (section 39)', () => {
  it('sends the ticked departments the role doesn’t already include, with files only while the department is ticked', () => {
    const choice = { DISPATCH: { on: true, files: true }, SAFETY: { on: true, files: false } };
    assert.deepEqual(chosenGrants('SAFETY_MANAGER', choice), [{ department: 'DISPATCH', withFiles: true }]);
    assert.deepEqual(chosenGrants('DISPATCHER_MANAGER', choice), [{ department: 'SAFETY', withFiles: false }]);
    assert.deepEqual(chosenGrants('SYSTEM_ADMIN', choice), []);
    assert.deepEqual(chosenGrants('VIEWER', choice), [{ department: 'DISPATCH', withFiles: true }, { department: 'SAFETY', withFiles: false }]);
    assert.deepEqual(chosenGrants('IT_SPECIALIST', { DISPATCH: { on: false, files: true }, SAFETY: { on: false, files: false } }), []);
  });
  it('reads grants back into the dialog and names them for the table', () => {
    assert.deepEqual(viewChoice([{ department: 'SAFETY', withFiles: true }]), { DISPATCH: { on: false, files: false }, SAFETY: { on: true, files: true } });
    assert.equal(viewLabel([{ department: 'DISPATCH', withFiles: false }, { department: 'SAFETY', withFiles: true }]), 'Dispatch, Safety');
  });
});
