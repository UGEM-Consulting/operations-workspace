import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretBox } from '../auth/mfa-crypto';

/** Digits only; null unless it is a structurally valid SSN (no 000, 666 or 9xx area, 00 group or 0000 serial). */
export function normalSsn(value: string): string | null {
 const digits = value.replace(/[\s-]/g, '');
 if (!/^\d{9}$/.test(digits)) return null;
 const area = digits.slice(0, 3), group = digits.slice(3, 5), serial = digits.slice(5);
 if (area === '000' || area === '666' || area.startsWith('9') || group === '00' || serial === '0000') return null;
 return digits;
}

/**
 * Encrypts driver SSNs with AES-256-GCM under PII_ENCRYPTION_KEY, bound to the driver ID so a ciphertext cannot be
 * moved to another driver. Without the key, entering or viewing an SSN fails closed with 503; nothing else is affected.
 */
@Injectable()
export class PiiService {
 private readonly box: SecretBox | null;
 constructor(config: ConfigService) {
  const key = config.get<string>('PII_ENCRYPTION_KEY');
  this.box = key ? new SecretBox(key) : null;
 }
 get enabled() { return this.box !== null; }
 sealSsn(value: string, driverId: string) {
  const ssn = normalSsn(value);
  if (!ssn) throw new BadRequestException('Enter a valid 9-digit Social Security number.');
  return { ciphertext: this.require().seal(ssn, `ssn:${driverId}`), last4: ssn.slice(5) };
 }
 openSsn(ciphertext: string, driverId: string) {
  const ssn = this.require().open(ciphertext, `ssn:${driverId}`);
  return `${ssn.slice(0, 3)}-${ssn.slice(3, 5)}-${ssn.slice(5)}`;
 }
 private require() {
  if (!this.box) throw new ServiceUnavailableException('Social Security numbers can’t be stored or shown until encryption is configured.');
  return this.box;
 }
}
