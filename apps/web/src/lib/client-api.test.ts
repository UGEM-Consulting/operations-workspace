import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, apiMessages, errorMessage, mutate, readApi, responseError } from './client-api.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function respond(status: number, body: string, contentType = 'application/json') {
  globalThis.fetch = (async () => new Response(status === 204 ? null : body, { status, headers: { 'content-type': contentType } })) as typeof fetch;
}
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try { await promise; } catch (error) { assert.ok(error instanceof ApiError); return error; }
  return assert.fail('expected the request to fail');
}

describe('mutate error mapping', () => {
  it('turns a network drop into the connection message, never "Failed to fetch"', async () => {
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    const error = await failure(mutate('applicant/draft', 'PATCH'));
    assert.equal(error.kind, 'network');
    assert.equal(error.message, apiMessages.network);
  });
  it('maps a non-JSON gateway timeout page to the wake-up wording, never a SyntaxError', async () => {
    respond(504, '<html>An error occurred with your deployment</html>', 'text/html');
    const error = await failure(mutate('onboarding/invitations', 'POST'));
    assert.equal(error.kind, 'unavailable');
    assert.equal(error.message, apiMessages.unavailable);
  });
  it('maps 413 from the gateway or the BFF to the file size message', async () => {
    respond(413, 'Request Entity Too Large', 'text/plain');
    assert.equal((await failure(mutate('documents', 'POST'))).message, apiMessages.tooLarge);
    respond(413, JSON.stringify({ message: 'Request too large' }));
    assert.equal((await failure(mutate('documents', 'POST'))).kind, 'too-large');
  });
  it('keeps an API 503 message, such as email delivery being unavailable', async () => {
    respond(503, JSON.stringify({ message: 'Email delivery is unavailable.' }));
    assert.equal((await failure(mutate('applicant/begin', 'POST'))).message, 'Email delivery is unavailable.');
  });
  it('reports a 409 as a conflict with the API message', async () => {
    respond(409, JSON.stringify({ message: 'Your application changed. Reload before saving.' }));
    const error = await failure(mutate('applicant/draft', 'PATCH'));
    assert.equal(error.kind, 'conflict');
    assert.equal(error.message, 'Your application changed. Reload before saving.');
  });
  it('joins validation message arrays', async () => {
    respond(400, JSON.stringify({ message: ['email must be an email', 'code is too short'] }));
    assert.equal((await failure(mutate('users', 'POST'))).message, 'email must be an email. code is too short');
  });
  it('returns null for 204 and parsed JSON for success', async () => {
    respond(204, '');
    assert.equal(await mutate('notifications/x/read', 'POST'), null);
    respond(200, JSON.stringify({ ok: 1 }));
    assert.deepEqual(await readApi<{ ok: number }>('notifications'), { ok: 1 });
  });
  it('treats a non-JSON success page as a gateway failure', async () => {
    respond(200, '<html>Starting</html>', 'text/html');
    assert.equal((await failure(readApi('notifications'))).kind, 'unavailable');
  });
});

describe('refused requests', () => {
  it('keeps the fields the API names in missing, and only strings', () => {
    const refused = responseError('driver/application/submit', 400, { message: 'Check your date of birth.', missing: ['dateOfBirth', 7] }, true);
    assert.equal(refused.message, 'Check your date of birth.');
    assert.deepEqual(refused.missing, ['dateOfBirth']);
    assert.deepEqual(responseError('driver/application/submit', 400, { message: 'Invalid request body' }, true).missing, []);
  });
});

describe('401 handling', () => {
  it('distinguishes an ended staff session from an expired applicant session', () => {
    const staff = responseError('it/onboarding/x/contact', 401, { message: 'Unauthorized' }, true);
    assert.equal(staff.kind, 'session');
    assert.equal(staff.message, apiMessages.session);
    const applicant = responseError('applicant/draft', 401, { message: 'Please verify your access again.' }, true);
    assert.equal(applicant.kind, 'applicant-session');
    assert.equal(applicant.message, apiMessages.applicantSession);
  });
  it('keeps final applicant messages, which re-verification cannot fix', () => {
    const closed = responseError('applicant/draft', 401, { message: 'Application access has expired. Contact your manager.' }, true);
    assert.equal(closed.kind, 'request');
    assert.equal(closed.message, 'Application access has expired. Contact your manager.');
  });
  it('never treats a driver 401 as an ended staff session', () => {
    let ended = false;
    const listener = () => { ended = true; };
    globalThis.addEventListener?.('workspace:session-ended', listener);
    const expired = responseError('driver/application', 401, { message: 'Unauthorized' }, true);
    assert.equal(expired.kind, 'applicant-session');
    assert.equal(expired.message, apiMessages.driverSession);
    const closed = responseError('driver/application', 401, { message: 'This application link is no longer available. Please contact Safety.' }, true);
    assert.equal(closed.message, 'This application link is no longer available. Please contact Safety.');
    assert.equal(responseError('driver/verify', 401, { message: 'Verification is invalid or expired.' }, true).message, 'Verification is invalid or expired.');
    globalThis.removeEventListener?.('workspace:session-ended', listener);
    assert.equal(ended, false);
  });
  it('treats 401 on credential endpoints as a wrong password or code', () => {
    const login = responseError('auth/login', 401, { message: 'Invalid email or password' }, true);
    assert.equal(login.kind, 'request');
    assert.equal(login.message, 'Invalid email or password');
    assert.equal(responseError('applicant/verify', 401, { message: 'Verification is invalid or expired.' }, true).kind, 'request');
    // An expired forced password-change step keeps its own message instead of the workspace session notice.
    const password = responseError('auth/password', 401, { message: 'Your sign-in expired. Sign in again.' }, true);
    assert.equal(password.kind, 'request');
    assert.equal(password.message, 'Your sign-in expired. Sign in again.');
  });
});

describe('errorMessage', () => {
  it('never exposes a raw exception message', () => {
    assert.equal(errorMessage(new SyntaxError('Unexpected token < in JSON'), 'Fallback'), 'Fallback');
    assert.equal(errorMessage(new ApiError('Shown', 'request')), 'Shown');
  });
});
