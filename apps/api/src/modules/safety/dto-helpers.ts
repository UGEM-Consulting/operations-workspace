import { Transform } from 'class-transformer';

// Shared by the Safety DTOs: trimmed text, trimmed upper-case codes, and whether an optional value was given.
export const text = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
export const upper = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toUpperCase() : value);
export const filled = (_object: unknown, value: unknown) => value !== undefined && value !== null && value !== '';
