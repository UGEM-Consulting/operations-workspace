import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signButtonLabel } from './sign-label.ts';

describe('the signing window’s Sign button', () => {
  it('names a short document, as the designs do', () => {
    assert.deepEqual(signButtonLabel('NDA', true), { text: 'Sign NDA', label: 'Sign NDA' });
    assert.deepEqual(signButtonLabel('SOP', true), { text: 'Sign SOP', label: 'Sign SOP' });
    assert.equal(signButtonLabel('contact list', false).text, 'Confirm contact list');
  });
  it('drops a long name from the button so it fits a phone, keeping it for screen readers', () => {
    // On staging the acknowledgement's 406px label pushed the signing window sideways on a 375px phone.
    const long = signButtonLabel('Driver and Contractor Acknowledgement (staging test)', true);
    assert.equal(long.text, 'Sign');
    assert.equal(long.label, 'Sign Driver and Contractor Acknowledgement (staging test)');
    assert.equal(signButtonLabel('Background check authorization', true).text, 'Sign');
  });
});
