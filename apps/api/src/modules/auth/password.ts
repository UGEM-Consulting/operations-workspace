import { randomInt } from 'crypto';
import { argon2id, hash, verify } from 'argon2';
// Leaves out characters that look alike when someone reads or retypes it: 0 O o, 1 I l.
const GENERATED_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** A first password an administrator sends to someone: 16 random characters in four groups, about 92 bits. */
export const generatePassword = () => Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => GENERATED_ALPHABET[randomInt(GENERATED_ALPHABET.length)]).join('')).join('-');
export const hashPassword = (password: string) => hash(password, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
export const verifyPassword = (encoded: string, password: string) => verify(encoded, password);
