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
    assert.equal(bodyLimit(`safety/drivers/${ID}/trucks/${ID}/documents`), 4_400_000);
    assert.equal(isFileEndpoint(`safety/drivers/${ID}/trucks/${ID}/documents/${ID}/file`), true);
    assert.equal(bodyLimit(`safety/drivers/${ID}/annual-reviews`), 4_400_000);
    assert.equal(bodyLimit(`driver/consents/${ID}/sign`), 400_000);
  });
});

describe('driver screening through the BFF', () => {
  it('allows the screening and decision mutations, and nothing beside them', () => {
    for (const path of [`safety/drivers/${ID}/checks/IDENTITY`, `safety/drivers/${ID}/mvr`, `safety/drivers/${ID}/left`, `safety/drivers/${ID}/annual-reviews`, `safety/drivers/${ID}/tests`, `safety/drivers/${ID}/trucks`, `safety/drivers/${ID}/trucks/${ID}`, `safety/drivers/${ID}/trucks/${ID}/archive`, `safety/drivers/${ID}/trucks/${ID}/documents`, `safety/drivers/${ID}/tests/${ID}/void`, `safety/drivers/${ID}/incidents`, `safety/drivers/${ID}/incidents/${ID}/settle`, `safety/drivers/${ID}/incidents/${ID}/void`, `safety/drivers/${ID}/corrections`, `safety/drivers/${ID}/send-for-decision`, `safety/drivers/${ID}/decision`])
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

describe('driver clearance and dispatch assignment through the BFF', () => {
  it('allows the clearance mutations and the assignment, and nothing beside them', () => {
    for (const path of [`safety/drivers/${ID}/clearance/DRUG_TEST`, `safety/drivers/${ID}/employers`, `safety/drivers/${ID}/employers/${ID}`, `safety/drivers/${ID}/employers/${ID}/remove`,
      `safety/drivers/${ID}/clear`, `dispatch/drivers/${ID}/assign`, `team/drivers/${ID}/assign`])
      assert.equal(allowedEndpoint('POST', path), true, path);
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/clearance/drug_test`), false);
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/employers/${ID}/delete`), false);
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/clear/undo`), false);
    assert.equal(allowedEndpoint('POST', `dispatch/drivers/${ID}/unassign`), false);
    // Lists and dialog options are read by server pages, never through the BFF.
    assert.equal(allowedEndpoint('GET', 'dispatch/drivers'), false);
    assert.equal(bodyLimit(`dispatch/drivers/${ID}/assign`), 16384);
  });
});

describe('offboarding and manager hand-over through the BFF', () => {
  it('allows the IT task list, the removal checklist and the hand-over routes, and nothing beside them', () => {
    assert.equal(allowedEndpoint('GET', 'it/tasks'), true);
    assert.equal(allowedEndpoint('GET', `it/removals/${ID}`), true);
    assert.equal(allowedEndpoint('PATCH', `it/removals/${ID}/tasks/SHARED_PASSWORDS`), true);
    assert.equal(allowedEndpoint('PATCH', `it/removals/${ID}/tasks/shared`), false);
    // A team lead's sign-in: one step, by its id only.
    assert.equal(allowedEndpoint('POST', `it/sign-ins/${ID}`), true);
    assert.equal(allowedEndpoint('GET', `it/sign-ins/${ID}`), false);
    assert.equal(allowedEndpoint('POST', `it/sign-ins/${ID}/extra`), false);
    assert.equal(allowedEndpoint('DELETE', `it/removals/${ID}`), false);
    assert.equal(allowedEndpoint('POST', `onboarding/applications/${ID}/manager`), true);
    assert.equal(allowedEndpoint('GET', `onboarding/applications/${ID}/manager`), false);
    assert.equal(allowedEndpoint('GET', `users/${ID}/open-records`), true);
    assert.equal(allowedEndpoint('POST', `users/${ID}/open-records`), false);
    for (const action of ['last-day', 'cancel-notice', 'remove-access']) assert.equal(allowedEndpoint('POST', `dispatch/members/${ID}/${action}`), true, action);
    assert.equal(allowedEndpoint('GET', `dispatch/members/${ID}/last-day`), false);
    assert.equal(allowedEndpoint('POST', `applicant/documents/${ID}/acknowledge`), true);
    assert.equal(allowedEndpoint('GET', `applicant/documents/${ID}/acknowledge`), false);
    // People already working here.
    for (const path of ['dispatch/existing/check', 'dispatch/existing/add', 'dispatch/paperwork/links']) { assert.equal(allowedEndpoint('POST', path), true, path); assert.equal(allowedEndpoint('DELETE', path), false, path); }
    for (const path of ['dispatch/existing/options', 'dispatch/paperwork']) assert.equal(allowedEndpoint('GET', path), false, path);
    assert.equal(allowedEndpoint('PATCH', `dispatch/members/${ID}/existing`), true);
    for (const action of ['place', 'start-date', 'support-type']) { assert.equal(allowedEndpoint('POST', `dispatch/members/${ID}/${action}`), true, action); assert.equal(allowedEndpoint('GET', `dispatch/members/${ID}/${action}`), false, action); }
    assert.equal(allowedEndpoint('POST', `dispatch/members/${ID}/more-time`), true);
    assert.equal(allowedEndpoint('GET', `dispatch/members/${ID}/more-time`), false);
    assert.equal(bodyLimit('dispatch/existing/add'), 1_000_000);
    assert.equal(bodyLimit('dispatch/paperwork/links'), 16384);
  });
});
