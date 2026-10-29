import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applicationDraftResolver, applicationSubmitSchema, applicationValidationFeedback, employmentFields, personalFields, stepIssues, type ApplicationValues } from './application-schema.ts';

const blank: ApplicationValues = { firstName: '', lastName: '', personalPhoneNumber: '', workPhoneNumber: '', preferredAmericanFirstName: '', preferredAmericanLastName: '', telegram: '', mcName: '', teamLead: '', jobTitle: 'Dispatcher', accurate: false };
const personal: ApplicationValues = { ...blank, firstName: 'Avery', lastName: 'Quinn', personalPhoneNumber: '+1 202 555 0190', preferredAmericanFirstName: 'Avery', preferredAmericanLastName: 'Quinn' };
// The real react-hook-form resolver, called the way useForm calls it.
const resolve = (values: ApplicationValues) => applicationDraftResolver(values, undefined, { fields: {}, shouldUseNativeValidation: false } as never);

describe('draft resolver (every save, including fields on steps that are not shown)', () => {
  it('accepts an incomplete draft', async () => {
    assert.deepEqual(Object.keys((await resolve(blank)).errors), []);
  });
  it('rejects a malformed phone even when its step is not shown', async () => {
    assert.deepEqual(Object.keys((await resolve({ ...blank, workPhoneNumber: '12' })).errors), ['workPhoneNumber']);
  });
});

describe('Continue validates only the current step', () => {
  it('requires the personal fields on step 1 but not employment', () => {
    assert.deepEqual(stepIssues(blank, false, personalFields).map(issue => issue.path[0]), ['firstName', 'lastName', 'personalPhoneNumber', 'preferredAmericanFirstName', 'preferredAmericanLastName']);
    assert.equal(stepIssues(personal, false, personalFields).length, 0);
  });
  it('requires Telegram only when the invitation does', () => {
    assert.deepEqual(stepIssues(personal, true, personalFields).map(issue => issue.path[0]), ['telegram']);
  });
  it('checks employment on step 2 and never the accuracy confirmation', () => {
    assert.deepEqual(stepIssues(personal, false, employmentFields).map(issue => issue.path[0]), ['mcName', 'teamLead']);
    assert.equal(stepIssues({ ...personal, mcName: 'Independent', teamLead: 'Independent' }, false, employmentFields).length, 0);
  });
  it('asks a support for no employment, since it follows the dispatcher they assist', () => {
    assert.equal(stepIssues({ ...personal, jobTitle: '' }, false, employmentFields, true).length, 0);
    assert.equal(applicationSubmitSchema(false, true).safeParse({ ...personal, jobTitle: '', accurate: true }).success, true);
  });
  it('skips locked fields, so a correction is never blocked by a value the applicant cannot change', () => {
    assert.equal(stepIssues(blank, true, ['mcName']).filter(issue => issue.path[0] === 'telegram').length, 0);
  });
});

describe('final submission stays stricter than Continue', () => {
  it('still requires the accuracy confirmation and routes errors to the earliest step', () => {
    const late = applicationSubmitSchema(false).safeParse({ ...personal, mcName: 'Independent', teamLead: 'Independent' });
    assert.equal(late.success, false);
    const feedback = applicationValidationFeedback(late.error!.issues);
    assert.equal(feedback.field, 'accurate');
    assert.equal(feedback.step, 2);
    const early = applicationValidationFeedback(applicationSubmitSchema(false).safeParse(blank).error!.issues);
    assert.equal(early.step, 0);
    assert.equal(early.field, 'firstName');
  });
});
