import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedEndpoint, bodyLimit, forwardedQuery, isFileEndpoint } from './bff-policy.ts';
import { deviceCookieName, usesDeviceCookie } from './session-cookie.ts';

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

describe('a new authenticator through the BFF', () => {
  it('allows starting and confirming it, and nothing else', () => {
    for (const path of ['auth/mfa/replacement', 'auth/mfa/replacement/confirm']) assert.equal(allowedEndpoint('POST', path), true, path);
    assert.equal(allowedEndpoint('GET', 'auth/mfa/replacement'), false);
    assert.equal(allowedEndpoint('POST', 'auth/mfa/replacement/cancel'), false);
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
    // The task list is read by the server page only.
    assert.equal(allowedEndpoint('GET', 'it/tasks'), false);
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
    // Leave (section 35) and an administrator's corrections (section 36); IT's suspend and restore checklists.
    for (const action of ['on-leave', 'on-leave/return', 'on-leave/cancel', 'on-leave/back-on', 'on-leave/reason', 'correct']) assert.equal(allowedEndpoint('POST', `dispatch/members/${ID}/${action}`), true, action);
    assert.equal(allowedEndpoint('POST', `dispatch/members/${ID}/on-leave/delete`), false);
    assert.equal(allowedEndpoint('GET', `it/leave/${ID}`), true);
    assert.equal(allowedEndpoint('PATCH', `it/leave/${ID}/tasks/GOOGLE_WORKSPACE`), true);
    assert.equal(allowedEndpoint('PATCH', `it/leave/${ID}/tasks/google`), false);
    assert.equal(allowedEndpoint('GET', `dispatch/members/${ID}/last-day`), false);
    assert.equal(allowedEndpoint('POST', `applicant/documents/${ID}/acknowledge`), true);
    assert.equal(allowedEndpoint('GET', `applicant/documents/${ID}/acknowledge`), false);
    // People already working here.
    for (const path of ['dispatch/existing/check', 'dispatch/existing/add', 'dispatch/paperwork/links']) { assert.equal(allowedEndpoint('POST', path), true, path); assert.equal(allowedEndpoint('DELETE', path), false, path); }
    for (const path of ['dispatch/existing/options', 'dispatch/paperwork']) assert.equal(allowedEndpoint('GET', path), false, path);
    assert.equal(allowedEndpoint('PATCH', `dispatch/members/${ID}/existing`), true);
    for (const action of ['place', 'start-date', 'support-type']) { assert.equal(allowedEndpoint('POST', `dispatch/members/${ID}/${action}`), true, action); assert.equal(allowedEndpoint('GET', `dispatch/members/${ID}/${action}`), false, action); }
    assert.equal(allowedEndpoint('POST', `dispatch/members/${ID}/more-time`), true);
    // Asking IT to set things up for a support or updater (section 32).
    assert.equal(allowedEndpoint('POST', `dispatch/members/${ID}/it-setup`), true);
    assert.equal(allowedEndpoint('GET', `dispatch/members/${ID}/it-setup`), false);
    assert.equal(allowedEndpoint('POST', `dispatch/members/${ID}/it-setup/cancel`), false);
    assert.equal(allowedEndpoint('GET', `dispatch/members/${ID}/more-time`), false);
    assert.equal(bodyLimit('dispatch/existing/add'), 1_000_000);
    assert.equal(bodyLimit('dispatch/paperwork/links'), 16384);
  });
});

describe('trusted devices and paper scans through the BFF (section 38)', () => {
  it('allows listing and forgetting devices, and forwards the device cookie only on sign-in and those routes', () => {
    assert.equal(allowedEndpoint('GET', 'auth/mfa/devices'), true);
    assert.equal(allowedEndpoint('POST', 'auth/mfa/devices/forget-all'), true);
    assert.equal(allowedEndpoint('POST', `auth/mfa/devices/${ID}/forget`), true);
    assert.equal(allowedEndpoint('POST', 'auth/mfa/devices'), false);
    assert.equal(allowedEndpoint('GET', `auth/mfa/devices/${ID}`), false);
    for (const path of ['auth/login', 'auth/mfa/verify', 'auth/mfa/devices', `auth/mfa/devices/${ID}/forget`, 'auth/mfa/devices/forget-all']) assert.equal(usesDeviceCookie(path), true, path);
    for (const path of ['auth/me', 'auth/mfa', 'auth/mfa/challenge', 'users', `dispatch/members/${ID}`]) assert.equal(usesDeviceCookie(path), false, path);
    assert.equal(deviceCookieName('production'), '__Host-operations.device');
    assert.equal(deviceCookieName('development'), 'operations.device');
  });
  it('allows adding a paper scan with room for a PDF, and opening one as a file', () => {
    assert.equal(allowedEndpoint('POST', `dispatch/members/${ID}/paper-scans`), true);
    assert.equal(bodyLimit(`dispatch/members/${ID}/paper-scans`), 4_400_000);
    assert.equal(isFileEndpoint(`dispatch/members/${ID}/paper-scans/${ID}/file`), true);
    assert.equal(allowedEndpoint('GET', `dispatch/members/${ID}/paper-scans/${ID}/file`), true);
    assert.equal(allowedEndpoint('POST', `dispatch/members/${ID}/paper-scans/${ID}/delete`), false);
  });
});

describe('load board accounts and seats through the BFF', () => {
  it('lets IT and administrators keep the accounts and seats, and nothing else under them', () => {
    assert.equal(allowedEndpoint('POST', 'lists/load-board-accounts'), true);
    assert.equal(allowedEndpoint('PATCH', 'lists/load-board-accounts/2c3c0529-044c-450f-901f-201b8d17aa00'), true);
    assert.equal(allowedEndpoint('POST', 'load-board-seats'), true);
    assert.equal(allowedEndpoint('POST', 'load-board-seats/2c3c0529-044c-450f-901f-201b8d17aa00'), true);
    assert.equal(allowedEndpoint('GET', 'load-board-seats/people'), false);
    assert.equal(allowedEndpoint('POST', 'load-board-seats/people'), false);
    assert.equal(allowedEndpoint('POST', 'company-accounts'), true);
    assert.equal(allowedEndpoint('PATCH', 'company-accounts/2c3c0529-044c-450f-901f-201b8d17aa00'), true);
    assert.equal(allowedEndpoint('GET', 'company-accounts'), false);
  });
});

describe('people who left and other names through the BFF', () => {
  it('lets the dispatcher page save a last day, ask IT to close accounts and edit names', () => {
    for (const route of ['left-day', 'close-accounts', 'names']) {
      assert.equal(allowedEndpoint('POST', `dispatch/members/2c3c0529-044c-450f-901f-201b8d17aa00/${route}`), true);
      assert.equal(allowedEndpoint('GET', `dispatch/members/2c3c0529-044c-450f-901f-201b8d17aa00/${route}`), false);
    }
    assert.equal(allowedEndpoint('POST', 'dispatch/members/not-an-id/names'), false);
  });
});

describe('the Dispatchers list through the BFF', () => {
  it('reads the list with its filters, so the filter sheet can say how many match, and nothing else under it', () => {
    assert.equal(allowedEndpoint('GET', 'dispatch/members'), true);
    assert.equal(allowedEndpoint('POST', 'dispatch/members'), false);
    assert.deepEqual(forwardedQuery('dispatch/members'), ['page', 'pageSize', 'status', 'search', 'sort', 'direction', 'mcId', 'teamId', 'leadId', 'jobTitleId', 'position', 'source', 'drivers', 'only', 'loadBoardAccountId']);
    assert.deepEqual(forwardedQuery('onboarding/review-queue'), ['page', 'pageSize', 'status', 'search', 'sort', 'direction']);
    assert.deepEqual(forwardedQuery('dispatch/teams'), []);
  });
});
