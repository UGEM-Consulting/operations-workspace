import type { ApplicantRecord } from './types';

/**
 * A photo a manager asked to correct that hasn't been replaced since they asked: the old one still counts as uploaded, so the
 * step and the card say so themselves instead of looking finished.
 */
export function photoStillRequested(record: Pick<ApplicantRecord, 'correction' | 'documents'>, item: 'selfiePhoto' | 'idPhoto') {
 const correction = record.correction, uploaded = record.documents.photos[item === 'selfiePhoto' ? 'selfie' : 'idSelfie'];
 return !!correction?.requestedFields.includes(item) && (!uploaded || Date.parse(uploaded) <= Date.parse(correction.createdAt));
}
