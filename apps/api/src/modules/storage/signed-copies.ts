import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StorageService } from './storage.service';

export type CopyOwner = { applicationId: string; companyDocumentId: string } | { driverId: string; consentDocumentId: string };
export interface MissingCopy { key: string; owner: CopyOwner; }
const EVERY_MS = 2 * 60_000;

/**
 * Saves each completed signed copy (the original PDF plus its certificate page, staff version) into the person's signed/
 * folder once, and records it in signed_copies. Downloads keep generating copies from the immutable records, so a slow or
 * failed save never affects signing, approval or downloads: a copy that isn't saved yet is simply tried again on the next
 * run (at startup, then every 2 minutes), which also saves copies for everyone who signed before this existed.
 * One instance runs at a time (a session advisory lock), so an unrecorded file at a key is only ever this job's own
 * interrupted save and may be replaced; a recorded copy is never written again.
 */
export class SignedCopyArchive {
 private readonly logger: Logger;
 private timer: NodeJS.Timeout | null = null;
 private running = false;
 constructor(name: string, private readonly db: DataSource, private readonly storage: StorageService, private readonly lock: number,
  private readonly missing: () => Promise<MissingCopy[]>, private readonly render: (copy: MissingCopy) => Promise<Buffer>) { this.logger = new Logger(name); }
 start() {
  if (!this.storage.enabled) return;
  this.stop();
  void this.run();
  this.timer = setInterval(() => void this.run(), EVERY_MS);
  this.timer.unref();
 }
 stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
 /** Saves the copies not saved yet and returns how many it saved. */
 async run(): Promise<number> {
  if (this.running || !this.storage.enabled) return 0;
  this.running = true;
  let saved = 0, failed = 0;
  const runner = this.db.createQueryRunner();
  try {
   await runner.connect();
   const [{ locked }] = await runner.query('SELECT pg_try_advisory_lock($1) AS locked', [this.lock]);
   if (!locked) return 0;
   try {
    for (const copy of await this.missing()) {
     try {
      const body = await this.render(copy);
      await this.storage.put(copy.key, body, 'application/pdf', { replaceUnrecorded: true });
      const owner = 'applicationId' in copy.owner ? [copy.owner.applicationId, copy.owner.companyDocumentId, null, null] : [null, null, copy.owner.driverId, copy.owner.consentDocumentId];
      await this.db.query(`INSERT INTO signed_copies ("storageKey", "applicationId", "companyDocumentId", "driverId", "consentDocumentId", sha256, "byteSize")
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`, [copy.key, ...owner, createHash('sha256').update(body).digest('hex'), body.length]);
      saved++;
     } catch { failed++; }
    }
   } finally { await runner.query('SELECT pg_advisory_unlock($1)', [this.lock]); }
  } catch { this.logger.error('Saving signed copies failed; it runs again later'); }
  finally { await runner.release(); this.running = false; }
  // Counts only: keys name people.
  if (saved) this.logger.log(`Saved ${saved} signed copies`);
  if (failed) this.logger.warn(`${failed} signed copies could not be saved yet; they are retried later`);
  return saved;
 }
}
