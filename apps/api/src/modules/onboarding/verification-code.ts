import { createHash, randomInt } from 'node:crypto';
// Existing token/code hashing contract shared by claiming, the local CLI and email delivery.
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
// The single definition of an applicant verification code: 8 random digits.
export const VERIFICATION_CODE_PATTERN = /^[0-9]{8}$/;
export const generateVerificationCode = () => randomInt(0, 100000000).toString().padStart(8, '0');
