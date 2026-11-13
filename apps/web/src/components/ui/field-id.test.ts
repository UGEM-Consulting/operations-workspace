import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fieldIdFor } from './field-id.ts';

describe('field ids', () => {
  it('keeps an explicit id, which the applicant form routes its errors to', () => {
    assert.equal(fieldIdFor('field-firstName', 'firstName', '«r1»'), 'field-firstName');
  });
  it('gives two fields without an id or a name different ids, so neither label points at the other', () => {
    // The driver's acknowledgement: the page's home address and the signing window's full legal name had both been field-undefined.
    const address = fieldIdFor(undefined, undefined, '«r1»'), name = fieldIdFor(undefined, undefined, '«r2»');
    assert.notEqual(address, name);
    assert.ok(!address.includes('undefined') && !name.includes('undefined'));
  });
  it('keeps the name readable and unique when two fields share one', () => {
    assert.notEqual(fieldIdFor(undefined, 'title', ':r3:'), fieldIdFor(undefined, 'title', ':r4:'));
    assert.match(fieldIdFor(undefined, 'title', ':r3:'), /^field-title-r3$/);
  });
  it('only uses characters that are safe in an id and a CSS selector', () => {
    assert.match(fieldIdFor(undefined, undefined, '«r1:»_x'), /^[A-Za-z0-9_-]+$/);
  });
});
