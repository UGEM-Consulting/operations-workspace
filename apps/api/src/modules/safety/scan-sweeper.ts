import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';

/**
 * A scan file is left alone until it is this old, so an upload between storing its file and committing its row (seconds)
 * is never mistaken for a leftover.
 */
export const LEFTOVER_SCAN_AGE_MS = 24 * 3600_000;
const SWEEP_MS = 6 * 3600_000, BATCH = 500;
const U = '[0-9a-f-]{36}', S = '[a-z]+(?:-[a-z]+)*';
const SCANS = `SELECT id FROM driver_documents WHERE id = ANY($1::uuid[]) AND NOT ("replacedAt" IS NOT NULL AND "verifiedAt" IS NULL)`;
// Every MVR row is kept, replaced ones included; only a file no row names (an upload that never committed) is a leftover.
const REPORTS = `SELECT id FROM driver_reports WHERE id = ANY($1::uuid[])`;
// A consent form whose publish never committed; every published version is kept.
const CONSENTS = `SELECT id FROM driver_consent_documents WHERE id = ANY($1::uuid[])`;
/**
 * Each listed prefix, and which file patterns under it are swept against which rows (both storage layouts). The captured
 * group is the record ID. A file matching no pattern, such as a saved signed copy under drivers/<driver>/signed/, is never touched.
 */
const SWEPT = [
 { prefix: 'drivers/', rules: [
  { pattern: new RegExp(`^drivers/${U}/(?:documents/${S}/)?(${U})\\.pdf$`), kept: SCANS },
  { pattern: new RegExp(`^drivers/${U}/reports/${S}/(${U})\\.pdf$`), kept: REPORTS },
 ] },
 { prefix: 'driver-reports/', rules: [{ pattern: new RegExp(`^driver-reports/${U}/(${U})\\.pdf$`), kept: REPORTS }] },
 { prefix: 'driver-consents/', rules: [{ pattern: new RegExp(`^driver-consents/(${U})\\.pdf$`), kept: CONSENTS }] },
 { prefix: 'company-documents/driver-consents/', rules: [{ pattern: new RegExp(`^company-documents/driver-consents/${S}/(${U})\\.pdf$`), kept: CONSENTS }] },
] as const;

/**
 * Removes driver scan files nothing should keep: a file with no driver_documents row (the API stopped between storing it
 * and committing, or its driver was deleted) and a replaced scan Safety never verified whose best-effort removal failed.
 * Current scans and verified ones (kept when a reopened application replaces them) are never touched, and neither is any
 * MVR or consent form (in either storage layout) that a row names, or any saved signed copy. Runs at startup
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
   for (const swept of SWEPT) {
    const files = (await this.storage.list(swept.prefix)).filter(file => now - file.storedAt.getTime() >= LEFTOVER_SCAN_AGE_MS);
    for (const rule of swept.rules) {
     const matched = files.flatMap(file => { const id = rule.pattern.exec(file.key)?.[1]; return id ? [{ key: file.key, id }] : []; });
     for (let start = 0; start < matched.length; start += BATCH) {
      const batch = matched.slice(start, start + BATCH);
      const rows: { id: string }[] = await this.db.query(rule.kept, [batch.map(file => file.id)]);
      const kept = new Set(rows.map(row => row.id));
      for (const file of batch) if (!kept.has(file.id)) { await this.storage.remove(file.key); removed++; }
     }
    }
   }
   // A count only: keys name drivers.
   if (removed) this.logger.log(`Removed ${removed} leftover scan files`);
  } catch { this.logger.error('Scan sweep failed; it runs again later'); }
  finally { this.sweeping = false; }
  return removed;
 }
}
