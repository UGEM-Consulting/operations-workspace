import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { photoStillRequested } from './photo-correction.ts';

const record = (photos: { selfie: string | null; idSelfie: string | null }, requestedFields: string[] = ['selfiePhoto']) => ({
  correction: { id: 'c', reason: 'Please retake your selfie.', requestedFields, createdAt: '2026-11-20T15:00:00.000Z' },
  documents: { required: true, missing: [], photos, consent: { text: '', translation: '' }, items: [] },
}) as unknown as Parameters<typeof photoStillRequested>[0];

describe('a photo a manager asked to correct', () => {
  it('still needs correction while the old photo is the one on file', () => {
    assert.equal(photoStillRequested(record({ selfie: '2026-11-10T12:00:00.000Z', idSelfie: null }), 'selfiePhoto'), true);
  });
  it('is done once a new photo was added after the request', () => {
    assert.equal(photoStillRequested(record({ selfie: '2026-11-21T09:00:00.000Z', idSelfie: null }), 'selfiePhoto'), false);
  });
  it('needs correction when no photo is on file, and never for a photo nobody asked about', () => {
    assert.equal(photoStillRequested(record({ selfie: null, idSelfie: null }), 'selfiePhoto'), true);
    assert.equal(photoStillRequested(record({ selfie: null, idSelfie: '2026-11-10T12:00:00.000Z' }), 'idPhoto'), false);
  });
});
