import { BadRequestException } from '@nestjs/common';
import { IsIn, IsInt, IsNumber, Max, Min } from 'class-validator';
import { degrees, PDFDocument, PDFFont, PDFImage, PDFPage, rgb, StandardFonts } from 'pdf-lib';
import { inspectSignaturePng } from './images';

export const FIELD_KINDS = ['SIGNATURE', 'NAME', 'DATE', 'DAY', 'MONTH', 'YEAR', 'TITLE'] as const;
export const FIELD_SIGNERS = ['SIGNER', 'COMPANY'] as const;
export const MAX_FIELDS = 60;
export type FieldKind = typeof FIELD_KINDS[number];
export type FieldSigner = typeof FIELD_SIGNERS[number];
/** A place on a page to fill in: a box given as fractions of the page as shown, from its top left. */
export interface DocumentField { page: number; x: number; y: number; width: number; height: number; kind: FieldKind; signer: FieldSigner }

export class DocumentFieldDto implements DocumentField {
 @IsInt() @Min(1) @Max(1000) page!: number;
 @IsNumber() @Min(0) @Max(1) x!: number;
 @IsNumber() @Min(0) @Max(1) y!: number;
 @IsNumber() @Min(0.005) @Max(1) width!: number;
 @IsNumber() @Min(0.005) @Max(1) height!: number;
 @IsIn(FIELD_KINDS) kind!: FieldKind;
 @IsIn(FIELD_SIGNERS) signer!: FieldSigner;
}

/** What a kind of document allows. A form nobody types into has no fields; only the company signs a Title. */
export function checkedFields(input: DocumentFieldDto[] | undefined, pageCount: number, rules: { signature: boolean; typedName: boolean; countersign: boolean }): DocumentField[] {
 const fields = input ?? [];
 if (fields.length && !rules.typedName) throw new BadRequestException('This document has no fields to fill in.');
 for (const field of fields) {
  if (field.page > pageCount) throw new BadRequestException('A field is on a page this document doesn’t have.');
  if (field.x + field.width > 1.001 || field.y + field.height > 1.001) throw new BadRequestException('A field runs off its page.');
  if (field.signer === 'COMPANY' && !rules.countersign) throw new BadRequestException('Nobody countersigns this document.');
  if (field.kind === 'TITLE' && field.signer !== 'COMPANY') throw new BadRequestException('Only the company’s signer has a title field.');
  if (field.kind === 'SIGNATURE' && !rules.signature) throw new BadRequestException('This document isn’t signed.');
 }
 return fields.map(({ page, x, y, width, height, kind, signer }) => ({ page, x, y, width, height, kind, signer }));
}

// The date shown on a form is the day it was signed in the US Eastern zone, like dates picked in the workspace.
const part = (at: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...options }).format(at);
export function fieldText(kind: FieldKind, signature: { typedName: string; signedAt: Date; signerTitle?: string | null }): string {
 switch (kind) {
  case 'NAME': return signature.typedName;
  case 'TITLE': return signature.signerTitle ?? '';
  case 'DATE': return part(signature.signedAt, { month: 'long', day: 'numeric', year: 'numeric' });
  case 'DAY': return part(signature.signedAt, { day: 'numeric' });
  case 'MONTH': return part(signature.signedAt, { month: 'long' });
  case 'YEAR': return part(signature.signedAt, { year: '2-digit' });
  default: return '';
 }
}

export interface FillSignature { signerRole: 'APPLICANT' | 'COMPANY'; typedName: string; signedAt: Date; signerTitle?: string | null; signatureImage: Buffer | null }
const INK = rgb(0.08, 0.13, 0.36);
const CENTRED: FieldKind[] = ['DAY', 'MONTH', 'YEAR'];
const latin = (text: string) => text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

/** A box as shown on screen, in the page's own coordinates: where to anchor and how to turn, for any page rotation. */
function placed(page: PDFPage, field: DocumentField) {
 const crop = page.getCropBox(), angle = ((page.getRotation().angle % 360) + 360) % 360;
 const sideways = angle % 180 !== 0, shownWidth = sideways ? crop.height : crop.width, shownHeight = sideways ? crop.width : crop.height;
 const left = field.x, bottom = field.y + field.height;
 const anchor = angle === 90 ? { x: crop.x + bottom * crop.width, y: crop.y + left * crop.height }
  : angle === 180 ? { x: crop.x + (1 - left) * crop.width, y: crop.y + bottom * crop.height }
   : angle === 270 ? { x: crop.x + (1 - bottom) * crop.width, y: crop.y + (1 - left) * crop.height }
    : { x: crop.x + left * crop.width, y: crop.y + (1 - bottom) * crop.height };
 const up = angle === 90 ? { x: -1, y: 0 } : angle === 180 ? { x: 0, y: -1 } : angle === 270 ? { x: 1, y: 0 } : { x: 0, y: 1 };
 return { anchor, up, width: field.width * shownWidth, height: field.height * shownHeight, rotate: degrees(angle) };
}

/** Writes each signer's name, signature and date into the places marked on this version. Returns how many were filled. */
export async function fillFields(pdf: PDFDocument, fields: DocumentField[], signatures: FillSignature[]): Promise<number> {
 if (!fields.length) return 0;
 const font: PDFFont = await pdf.embedFont(StandardFonts.TimesRoman), pages = pdf.getPages(), images = new Map<FillSignature, PDFImage>();
 let filled = 0;
 for (const field of fields) {
  const signature = signatures.find(row => row.signerRole === (field.signer === 'COMPANY' ? 'COMPANY' : 'APPLICANT')), page = pages[field.page - 1];
  if (!signature || !page) continue;
  const box = placed(page, field);
  if (field.kind === 'SIGNATURE') {
   // Only structurally checked images are decoded, as on the certificate.
   if (!signature.signatureImage || !inspectSignaturePng(signature.signatureImage)) continue;
   const image = images.get(signature) ?? await pdf.embedPng(signature.signatureImage);
   images.set(signature, image);
   const scale = Math.min(box.width / image.width, box.height / image.height);
   page.drawImage(image, { x: box.anchor.x, y: box.anchor.y, width: image.width * scale, height: image.height * scale, rotate: box.rotate });
  } else {
   const text = latin(fieldText(field.kind, signature));
   if (!text) continue;
   let size = Math.min(box.height * 0.8, 13);
   while (size > 5 && font.widthOfTextAtSize(text, size) > box.width) size -= 0.5;
   // A day, month or year sits in the middle of its short blank; anything else starts just inside its line.
   const room = Math.max(box.width - font.widthOfTextAtSize(text, size), 0), along = CENTRED.includes(field.kind) ? room / 2 : Math.min(2, room), lift = box.height * 0.2;
   page.drawText(text, { x: box.anchor.x + box.up.y * along + box.up.x * lift, y: box.anchor.y - box.up.x * along + box.up.y * lift, size, font, color: INK, rotate: box.rotate });
  }
  filled += 1;
 }
 return filled;
}
