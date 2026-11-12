import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { sha256 } from '../documents/images';
import type { FileResult } from '../documents/documents.service';
import { onboardingLimit } from '../onboarding/rate-limit';
import { oneUpload, uploadedPdf } from '../safety/scan';
import { usDay } from '../safety/screening-rules';
import { paperScanKey, StorageService } from '../storage/storage.service';
import type { User } from '../users/user.entity';
import type { PaperScanDto } from './dispatch.dto';
import { lockCatchUpLinks } from './create-member';
import { DispatchEvent, DispatchMember, MemberPaperDocument } from './dispatch.entity';
import { IMPORT_LOCK } from './existing.service';

// A paper NDA or SOP may run longer than four photographed pages, so an uploaded PDF may have more.
const MAX_PDF_PAGES = 30;
/**
 * Scans of an NDA or SOP signed on paper by someone added by hand (section 38, PaperScanUploadScreen). Dispatch managers and
 * administrators add one to a document recorded as signed on paper; it's kept in private storage at
 * members/<member>/paper/<kind>/<scan>.pdf. A new scan replaces the current one, which stays in storage and in the record,
 * listed as replaced (deleting belongs to the retention job, which isn't authorized). Only the NDA or SOP: the route takes
 * nothing else. Events hold the kind, page count and flags, never what the scan shows.
 */
@Injectable()
export class PaperScansService {
 constructor(private readonly db: DataSource, private readonly storage: StorageService) {}

 /** Whether scans can be added here (file storage is set up); the dispatcher page offers them only then. */
 get available() { return this.storage.enabled; }

 async upload(user: User, memberId: string, dto: PaperScanDto) {
  if (!this.storage.enabled) throw new ServiceUnavailableException('Scans can’t be added here: file storage isn’t set up.');
  const upload = oneUpload(dto, 'Upload one PDF or photos of each page.');
  if (dto.signedOn && dto.signedOn > usDay('latest')) throw new BadRequestException(`The ${dto.kind} date can’t be in the future.`);
  // Every rule is checked before a file is stored, so a refusal leaves nothing behind, and again under the locks.
  await this.check(this.db.manager, memberId, dto);
  await onboardingLimit(this.db, `paper-scan:${user.id}`, 30, 3600);
  const { body, pageCount } = await uploadedPdf(upload, MAX_PDF_PAGES);
  const stored = { id: randomUUID(), kind: dto.kind, memberId };
  await this.storage.put(paperScanKey(stored), body, 'application/pdf');
  try {
   return await this.db.transaction(async em => {
    // The order Edit recorded details takes (ExistingDispatchersService.update), since both can change the paper date.
    await em.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK]);
    await lockCatchUpLinks(em, memberId);
    const { member, paper, dateChanged } = await this.check(em, memberId, dto, true);
    if (dateChanged) {
     await em.getRepository(MemberPaperDocument).update(paper.id, { signedOn: dto.signedOn, recordedBy: user.id });
     // The same history entry as a date corrected in Edit recorded details.
     await em.getRepository(DispatchEvent).save({ memberId, teamId: null, event: 'EXISTING_UPDATED', actorId: user.id, metadata: { fields: [dto.kind] } });
    }
    const [, replaced] = await em.query(`UPDATE member_paper_scans SET "replacedAt" = now() WHERE "memberId" = $1 AND kind = $2 AND "replacedAt" IS NULL`, [memberId, dto.kind]) as [unknown, number];
    await em.query(`INSERT INTO member_paper_scans (id, "memberId", kind, "pageCount", sha256, "byteSize", "uploadedBy") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
     [stored.id, memberId, dto.kind, pageCount, sha256(body), body.length, user.id]);
    member.version += 1; await em.save(member);
    await em.getRepository(DispatchEvent).save({ memberId, teamId: null, event: 'PAPER_SCAN_ADDED', actorId: user.id, metadata: { kind: dto.kind, pages: pageCount, replaced: replaced > 0, dateChanged } });
    return { id: memberId, version: member.version, scanId: stored.id };
   });
  } catch (error) { await this.discard(stored); throw error; }
 }

 /**
  * Removes a refused upload's file, unless its row exists after all (a commit that succeeded but whose answer was lost). The
  * original error is always the one answered: a check or removal that fails leaves the file to ScanSweeper.
  */
 private async discard(stored: { id: string; kind: 'NDA' | 'SOP'; memberId: string }) {
  try {
   const [row] = await this.db.query(`SELECT 1 FROM member_paper_scans WHERE id = $1`, [stored.id]);
   if (!row) await this.storage.remove(paperScanKey(stored));
  } catch { /* swept later */ }
 }

 /** Opens a scan, current or replaced, for any dispatch manager or administrator; every open is recorded and rate-limited. */
 async file(user: User, memberId: string, scanId: string): Promise<FileResult> {
  await onboardingLimit(this.db, `paper-scan-view:${user.id}`, 60, 900);
  const [scan] = await this.db.query(`SELECT id, kind, "memberId" FROM member_paper_scans WHERE id = $1 AND "memberId" = $2`, [scanId, memberId]) as { id: string; kind: 'NDA' | 'SOP'; memberId: string }[];
  if (!scan) throw new NotFoundException('This scan no longer exists.');
  const body = await this.storage.get(paperScanKey(scan));
  await this.db.getRepository(DispatchEvent).save({ memberId, teamId: null, event: 'PAPER_SCAN_VIEWED', actorId: user.id, metadata: { kind: scan.kind } });
  return { body, type: 'application/pdf', filename: `${scan.kind.toLowerCase()}-paper-scan.pdf` };
 }

 /**
  * Whether this scan may be added: someone added by hand who hasn't left, the version the page showed, that document on file on
  * paper, and a corrected date only under Edit recorded details' rules (not for a document they already signed in the workspace).
  */
 private async check(em: EntityManager, memberId: string, dto: PaperScanDto, lock = false) {
  const member = await em.getRepository(DispatchMember).findOne({ where: { id: memberId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
  if (!member) throw new NotFoundException('This dispatcher record no longer exists.');
  const [record] = await em.query(`SELECT 1 FROM existing_member_records WHERE "memberId" = $1`, [memberId]);
  if (!record) throw new NotFoundException('Scans are only for people added by hand.');
  if (member.version !== dto.version) throw new ConflictException('Someone else changed this record. Reload and try again.');
  if (member.status === 'LEFT') throw new ConflictException('This dispatcher has left; their record is kept for history.');
  const paper = await em.getRepository(MemberPaperDocument).findOneBy({ memberId, kind: dto.kind });
  if (!paper) throw new BadRequestException(`Record the date the ${dto.kind} was signed on paper first, in Edit recorded details.`);
  const dateChanged = !!dto.signedOn && dto.signedOn !== paper.signedOn;
  if (dateChanged) {
   const [signed] = await em.query(`SELECT 1 FROM invitations i JOIN dispatcher_applications a ON a."invitationId" = i.id JOIN document_signatures s ON s."applicationId" = a.id AND s."signerRole" = 'APPLICANT'
     JOIN company_documents c ON c.id = s."documentId" WHERE i."catchUpMemberId" = $1 AND c.kind = $2 LIMIT 1`, [memberId, dto.kind]);
   if (signed) throw new ConflictException(`They already signed the ${dto.kind} in the workspace.`);
  }
  return { member, paper, dateChanged };
 }
}
