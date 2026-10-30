import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';

/**
 * A scan file is left alone until it is this old, so an upload between storing its file and committing its row (seconds)
 * is never mistaken for a leftover.
 */
export const LEFTOVER_SCAN_AGE_MS = 24 * 3600_000;
const SWEEP_MS = 6 * 3600_000, BATCH = 500;

/**
 * Removes driver scan files nothing should keep: a file with no driver_documents row (the API stopped between storing it
 * and committing, or its driver was deleted) and a replaced scan Safety never verified whose best-effort removal failed.
 * Current scans and verified ones (kept when a reopened application replaces them) are never touched. Runs at startup
 * and every 6 hours; overlapping instances are harmless because removal is idempotent. Each file is checked against its
 * own row, and any failure stops the sweep, so a failed query never reads as "nothing is referenced".
 */
@Injectable()
export class ScanSweeper implements OnApplicationBootstrap, BeforeApplicationShutdown {
 private readonly logger = new Logger('ScanSweeper');
 private timer: NodeJS.Timeout | null = null;
 private sweeping = false;
 constructor(private readonly db: DataSource, private readonly storage: StorageService) {}
 onApplicationBootstrap() {
  if (!this.storage.enabled) return;
  if (this.timer) clearInterval(this.timer);
  void this.sweep();
  this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
  this.timer.unref();
 }
 beforeApplicationShutdown() { if (this.timer) clearInterval(this.timer); this.timer = null; }

 /** Returns how many leftover files it removed. `now` lets tests age the files instead of waiting. */
 async sweep(now = Date.now()): Promise<number> {
  if (this.sweeping || !this.storage.enabled) return 0;
  this.sweeping = true;
  let removed = 0;
  try {
   const files = (await this.storage.list('drivers/')).filter(file => now - file.storedAt.getTime() >= LEFTOVER_SCAN_AGE_MS);
   for (let start = 0; start < files.length; start += BATCH) {
    const batch = files.slice(start, start + BATCH).map(file => ({ key: file.key, id: file.key.slice(file.key.lastIndexOf('/') + 1, -'.pdf'.length) }));
    const rows: { id: string; discarded: boolean }[] = await this.db.query(
     `SELECT id, ("replacedAt" IS NOT NULL AND "verifiedAt" IS NULL) AS discarded FROM driver_documents WHERE id = ANY($1::uuid[])`, [batch.map(file => file.id)]);
    const kept = new Set(rows.filter(row => !row.discarded).map(row => row.id));
    for (const file of batch) if (!kept.has(file.id)) { await this.storage.remove(file.key); removed++; }
   }
   // A count only: keys name drivers.
   if (removed) this.logger.log(`Removed ${removed} leftover scan files`);
  } catch { this.logger.error('Scan sweep failed; it runs again later'); }
  finally { this.sweeping = false; }
  return removed;
 }
}
