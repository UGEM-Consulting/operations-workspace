import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedEndpoint, bodyLimit, isFileEndpoint } from './bff-policy.ts';

const ID = '3f2b8c1e-0a4d-4f6e-9b7a-1c2d3e4f5a6b';

describe('driver consent forms through the BFF', () => {
  it('allows publishing, opening and signing, with room for a PDF or a signature image', () => {
    assert.equal(allowedEndpoint('POST', 'safety/consents'), true);
    assert.equal(allowedEndpoint('POST', `driver/consents/${ID}/view`), true);
    assert.equal(allowedEndpoint('POST', `driver/consents/${ID}/sign`), true);
    assert.equal(allowedEndpoint('POST', `driver/consents/${ID}/delete`), false);
    for (const path of [`safety/consents/${ID}/file`, `safety/drivers/${ID}/consents/${ID}/signed`, `driver/consents/${ID}/file`, `driver/consents/${ID}/signed`]) assert.equal(isFileEndpoint(path), true, path);
    assert.equal(bodyLimit('safety/consents'), 4_400_000);
    assert.equal(bodyLimit(`driver/consents/${ID}/sign`), 400_000);
  });
});

describe('driver screening through the BFF', () => {
  it('allows the screening and decision mutations, and nothing beside them', () => {
    for (const path of [`safety/drivers/${ID}/checks/IDENTITY`, `safety/drivers/${ID}/mvr`, `safety/drivers/${ID}/corrections`, `safety/drivers/${ID}/send-for-decision`, `safety/drivers/${ID}/decision`])
      assert.equal(allowedEndpoint('POST', path), true, path);
    assert.equal(allowedEndpoint('GET', `safety/drivers/${ID}/decision`), false);
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/checks/identity`), false);
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/decision/undo`), false);
  });
  it('serves the MVR as a private file and lets only its upload carry a PDF', () => {
    assert.equal(isFileEndpoint(`safety/drivers/${ID}/reports/${ID}/file`), true);
    assert.equal(allowedEndpoint('GET', `safety/drivers/${ID}/reports/${ID}/file`), true);
    assert.equal(bodyLimit(`safety/drivers/${ID}/mvr`), 4_400_000);
    assert.equal(bodyLimit(`safety/drivers/${ID}/decision`), 16384);
  });
});
