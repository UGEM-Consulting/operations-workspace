import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { inspectPdf } from '../documents/certificate';
import { decodePdf } from '../documents/images';
import { StorageService } from '../storage/storage.service';

/** A published PDF read and checked: its bytes and page count. */
export async function readPublishedPdf(base64: string) {
 const file = decodePdf(base64);
 const pageCount = await inspectPdf(file).catch(() => { throw new BadRequestException('The PDF could not be read. Upload an unencrypted PDF.'); });
 return { file, pageCount };
}

/**
 * Publishes a new immutable version of a consent form or notice letter: stores the file at `key`, then numbers the
 * version under the kind's advisory lock (42002032 with `lock`) so publishers of one kind take turns and versions stay
 * sequential, and saves the row. The stored file is removed if saving fails.
 */
export async function publishPdfVersion<T>(db: DataSource, storage: StorageService, input: { file: Buffer; key: string; lock: number;
 table: 'driver_consent_documents' | 'driver_notice_letters'; kind: string; save: (em: EntityManager, version: number) => Promise<T> }): Promise<T> {
 await storage.put(input.key, input.file, 'application/pdf');
 try {
  return await db.transaction(async em => {
   await em.query('SELECT pg_advisory_xact_lock(42002032, $1)', [input.lock]);
   const [{ next }] = await em.query(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM ${input.table} WHERE kind = $1`, [input.kind]);
   return input.save(em, Number(next));
  });
 } catch (error) { await storage.remove(input.key); throw error; }
}
