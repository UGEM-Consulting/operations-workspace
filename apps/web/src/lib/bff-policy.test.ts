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
  it('refuses other methods and unlisted paths on the yearly review, testing, incident and truck routes', () => {
    for (const path of [`safety/drivers/${ID}/left`, `safety/drivers/${ID}/annual-reviews`, `safety/drivers/${ID}/tests`, `safety/drivers/${ID}/incidents`, `safety/drivers/${ID}/tests/${ID}/void`,
      `safety/drivers/${ID}/incidents/${ID}/settle`, `safety/drivers/${ID}/incidents/${ID}/void`, `safety/drivers/${ID}/trucks`, `safety/drivers/${ID}/trucks/${ID}`, `safety/drivers/${ID}/trucks/${ID}/archive`, `safety/drivers/${ID}/trucks/${ID}/documents`]) {
      for (const method of ['GET', 'PATCH', 'DELETE']) assert.equal(allowedEndpoint(method, path), false, `${method} ${path}`);
    }
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/trucks/${ID}/documents/${ID}/file`), false);
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/trucks/${ID}/restore`), false);
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/tests/${ID}/settle`), false);
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/annual-reviews/${ID}/void`), false);
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/incidents/${ID}`), false);
  });
  it('serves the MVR as a private file and lets only its upload carry a PDF', () => {
    assert.equal(isFileEndpoint(`safety/drivers/${ID}/reports/${ID}/file`), true);
    assert.equal(allowedEndpoint('GET', `safety/drivers/${ID}/reports/${ID}/file`), true);
    assert.equal(bodyLimit(`safety/drivers/${ID}/mvr`), 4_400_000);
    assert.equal(bodyLimit(`safety/drivers/${ID}/decision`), 16384);
  });
});

describe('notice letters through the BFF', () => {
  it('allows publishing a letter and serves letters and a driver’s filled-in letter as private files', () => {
    assert.equal(allowedEndpoint('POST', 'safety/letters'), true);
    assert.equal(bodyLimit('safety/letters'), 4_400_000);
    for (const path of [`safety/letters/${ID}/file`, `safety/drivers/${ID}/letters/pre-adverse`, `safety/drivers/${ID}/letters/final`]) {
      assert.equal(isFileEndpoint(path), true, path);
      assert.equal(allowedEndpoint('GET', path), true, path);
      assert.equal(allowedEndpoint('POST', path), false, path);
    }
    assert.equal(isFileEndpoint(`safety/drivers/${ID}/letters/other`), false);
    assert.equal(allowedEndpoint('PATCH', 'safety/letters'), false);
  });
});

describe('expiration reminders through the BFF', () => {
  it('allows the driver’s own Telegram connection and Safety’s one-time link, and nothing else', () => {
    assert.equal(allowedEndpoint('GET', 'driver/telegram'), true);
    for (const path of ['driver/telegram/connect', 'driver/telegram/check', `safety/drivers/${ID}/telegram-link`]) assert.equal(allowedEndpoint('POST', path), true, path);
    assert.equal(allowedEndpoint('POST', 'driver/telegram'), false);
    assert.equal(allowedEndpoint('GET', 'driver/telegram/connect'), false);
    assert.equal(allowedEndpoint('GET', `safety/drivers/${ID}/telegram-link`), false);
    assert.equal(allowedEndpoint('POST', 'driver/telegram/disconnect'), false);
    assert.equal(bodyLimit(`safety/drivers/${ID}/telegram-link`), 16384);
  });
});

describe('document renewals through the BFF', () => {
  it('allows renewing, the renewal link and its cancellation, marking a scan as not readable, and the driver page', () => {
    for (const path of [`safety/drivers/${ID}/documents/renew`, `safety/drivers/${ID}/renewals`, `safety/drivers/${ID}/renewals/cancel`, `safety/drivers/${ID}/documents/${ID}/unreadable`, 'driver/renewal'])
      assert.equal(allowedEndpoint('POST', path), true, path);
    assert.equal(allowedEndpoint('GET', 'driver/renewal'), true);
    for (const method of ['GET', 'PATCH', 'DELETE']) assert.equal(allowedEndpoint(method, `safety/drivers/${ID}/renewals`), false, method);
    assert.equal(allowedEndpoint('PATCH', 'driver/renewal'), false);
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/renewals/${ID}`), false);
    assert.equal(allowedEndpoint('POST', `safety/drivers/${ID}/documents/renew/${ID}`), false);
  });
  it('lets only the two renewal uploads carry a document', () => {
    assert.equal(bodyLimit(`safety/drivers/${ID}/documents/renew`), 4_400_000);
    assert.equal(bodyLimit('driver/renewal'), 4_400_000);
    assert.equal(bodyLimit(`safety/drivers/${ID}/renewals`), 16384);
    assert.equal(bodyLimit(`safety/drivers/${ID}/documents/${ID}/unreadable`), 16384);
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
