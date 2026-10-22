import { createHash } from 'node:crypto';
// Existing token/code hashing contract shared by claiming, local CLI and delivery.
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
