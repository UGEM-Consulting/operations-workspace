import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MAX_PDF_BYTES, MAX_PHOTO_BYTES, MAX_SIGNATURE_BYTES } from './documents.dto';
export const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
// Browsers re-encode photos to JPEG before upload, which also drops camera metadata such as location.
export function decodeJpeg(base64: string): Buffer {
 const body = Buffer.from(base64, 'base64');
 if (body.length < 1000 || body.length > MAX_PHOTO_BYTES || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) throw new BadRequestException('Upload a JPEG photo up to 2.5 MB.');
 return body;
}
export function decodeSignature(dataUrl: string): Buffer {
 const body = Buffer.from(dataUrl.slice(dataUrl.indexOf(',')+1), 'base64');
 if (body.length < 100 || body.length > MAX_SIGNATURE_BYTES || !body.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) throw new BadRequestException('Draw your signature.');
 return body;
}
export function decodePdf(base64: string): Buffer {
 const body = Buffer.from(base64, 'base64');
 if (body.length > MAX_PDF_BYTES || body.subarray(0,5).toString('latin1') !== '%PDF-') throw new BadRequestException('Upload a PDF file up to 3 MB.');
 return body;
}
