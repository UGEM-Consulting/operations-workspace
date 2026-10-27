import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
// RFC 6238 defaults that every mainstream authenticator app supports.
const TOTP_SETTINGS = { algorithm: 'SHA1', digits: 6, period: 30 } as const;
export const RECOVERY_CODE_COUNT = 10;
// Crockford-style alphabet without easily confused characters (0/O, 1/I/L, U).
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** AES-256-GCM with the user ID as associated data, so a ciphertext cannot be moved to another account. */
export class SecretBox {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('Invalid MFA encryption key');
  }
  seal(plaintext: string, userId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv).setAAD(Buffer.from(userId));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }
  open(sealed: string, userId: string): string {
    const [version, iv, tag, data] = sealed.split(':');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported MFA secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64')).setAAD(Buffer.from(userId));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

export function newTotpSecret(): string { return new Secret({ size: 20 }).base32; }
export function totpUri(secret: string, account: string, issuer: string): string {
  return new TOTP({ ...TOTP_SETTINGS, issuer, label: account, secret: Secret.fromBase32(secret) }).toString();
}
/** Returns the matched time step (±1 step for clock drift), or null. Callers must reject steps already used. */
export function matchTotp(secret: string, token: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(token)) return null;
  const totp = new TOTP({ ...TOTP_SETTINGS, secret: Secret.fromBase32(secret) });
  const delta = totp.validate({ token, timestamp: now, window: 1 });
  return delta === null ? null : totp.counter({ timestamp: now }) + delta;
}
/** Groups the base32 key in fours for manual entry. */
export const formatManualKey = (secret: string) => secret.replace(/(.{4})(?=.)/g, '$1 ');

/** Ten characters (about 49 bits) shown as XXXXX-XXXXX. */
export function newRecoveryCode(): string {
  const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
/** Canonical form used for hashing and comparison; null when the input cannot be a recovery code. */
export function normalizeRecoveryCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${RECOVERY_ALPHABET}]{10}$`).test(code) ? code : null;
}
