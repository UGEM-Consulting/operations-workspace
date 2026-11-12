import { Transform } from 'class-transformer';

// Shared by the Safety DTOs: trimmed text, one-line text (inner spaces collapsed too), trimmed upper-case codes, and
// whether an optional value was given.
export const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
export const oneLine = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);
export const upper = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toUpperCase() : value);
export const filled = (_object: unknown, value: unknown) => value !== undefined && value !== null && value !== '';
