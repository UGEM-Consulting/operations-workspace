import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { MAX_PDF_BYTES, MAX_PHOTO_BYTES, MAX_SIGNATURE_BYTES } from './documents.dto';
export const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
export const MAX_PHOTO_SIDE = 8000;
// The signature pad draws on a 600 x 180 canvas; anything far larger is not from the pad.
export const MAX_SIGNATURE_WIDTH = 2000, MAX_SIGNATURE_HEIGHT = 800;

const invalidPhoto = () => new BadRequestException('Upload a JPEG photo up to 2.5 MB.');
// SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC).
const isFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
const isRestart = (marker: number) => marker >= 0xd0 && marker <= 0xd7;
/**
 * Rewrites a JPEG on the server, independent of the browser's re-encoding: walks every segment, keeps the JFIF
 * header (APP0), the Adobe colour-transform flag (APP14 "Adobe") and the segments needed to decode, and drops all
 * other application segments (EXIF, GPS, XMP, ICC, maker notes) and comments, plus anything after EOI.
 */
export function cleanJpeg(body: Buffer): Buffer {
 if (body[0] !== 0xff || body[1] !== 0xd8) throw invalidPhoto();
 const parts: Buffer[] = [body.subarray(0, 2)];
 let pos = 2, frame = false, scan = false;
 for (;;) {
  if (body[pos] !== 0xff) throw invalidPhoto();
  while (body[pos] === 0xff) pos++;
  if (pos >= body.length) throw invalidPhoto();
  const marker = body[pos++];
  if (marker === 0xd9) { if (!frame || !scan) throw invalidPhoto(); parts.push(Buffer.from([0xff, 0xd9])); return Buffer.concat(parts); }
  if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || isRestart(marker) || pos + 2 > body.length) throw invalidPhoto();
  const length = body.readUInt16BE(pos), end = pos + length;
  if (length < 2 || end > body.length) throw invalidPhoto();
  if (isFrame(marker)) {
   if (frame || length < 11) throw invalidPhoto();
   const height = body.readUInt16BE(pos + 3), width = body.readUInt16BE(pos + 5);
   if (!height || !width || height > MAX_PHOTO_SIDE || width > MAX_PHOTO_SIDE) throw new BadRequestException(`Upload a photo of at most ${MAX_PHOTO_SIDE} pixels per side.`);
   frame = true;
  }
  const adobe = marker === 0xee && length === 14 && body.subarray(pos + 2, pos + 7).toString('latin1') === 'Adobe';
  if (!((marker >= 0xe1 && marker <= 0xef && !adobe) || marker === 0xfe)) parts.push(body.subarray(pos - 2, end));
  pos = end;
  if (marker === 0xda) {
   if (!frame) throw invalidPhoto();
   scan = true;
   // Entropy-coded data runs until a marker that is neither a stuffed zero nor a restart marker.
   let next = pos;
   while (next + 1 < body.length && !(body[next] === 0xff && body[next + 1] !== 0x00 && !isRestart(body[next + 1]))) next++;
   if (next + 1 >= body.length) throw invalidPhoto();
   parts.push(body.subarray(pos, next)); pos = next;
  }
 }
}
// Browsers re-encode photos to JPEG before upload; the server strips metadata again and bounds the image size.
export function decodeJpeg(base64: string): Buffer {
 const body = Buffer.from(base64, 'base64');
 if (body.length < 1000 || body.length > MAX_PHOTO_BYTES) throw invalidPhoto();
 return cleanJpeg(body);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRITICAL_CHUNKS = ['IHDR', 'PLTE', 'IDAT', 'IEND'], ANIMATION_CHUNKS = ['acTL', 'fcTL', 'fdAT'];
/**
 * Structural PNG check, so a signature can never decode into a huge bitmap: CRC-valid chunks, IHDR first, no APNG,
 * bounded 8-bit RGB/RGBA non-interlaced dimensions, IEND last, and image data that inflates to exactly the expected size.
 */
export function inspectSignaturePng(body: Buffer): { width: number; height: number } | null {
 if (body.length < 100 || body.length > MAX_SIGNATURE_BYTES || !body.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
 let pos = 8, header: { width: number; height: number; channels: number } | null = null, ended = false;
 const data: Buffer[] = [];
 while (pos < body.length) {
  if (ended || pos + 12 > body.length) return null;
  const length = body.readUInt32BE(pos);
  if (length > body.length - pos - 12) return null;
  const type = body.subarray(pos + 4, pos + 8).toString('latin1'), chunk = body.subarray(pos + 8, pos + 8 + length);
  if (!/^[A-Za-z]{4}$/.test(type) || crc32(body.subarray(pos + 4, pos + 8 + length)) !== body.readUInt32BE(pos + 8 + length)) return null;
  // Unknown critical chunks (upper-case first letter) cannot be skipped safely; ancillary ones carry no pixels.
  if (ANIMATION_CHUNKS.includes(type) || (/^[A-Z]/.test(type) && !CRITICAL_CHUNKS.includes(type))) return null;
  if ((type === 'IHDR') !== (pos === 8)) return null;
  if (type === 'IHDR') {
   if (length !== 13) return null;
   const width = chunk.readUInt32BE(0), height = chunk.readUInt32BE(4), [depth, colour, compression, filter, interlace] = chunk.subarray(8);
   if (!width || !height || width > MAX_SIGNATURE_WIDTH || height > MAX_SIGNATURE_HEIGHT || depth !== 8 || ![2, 6].includes(colour) || compression || filter || interlace) return null;
   header = { width, height, channels: colour === 6 ? 4 : 3 };
  } else if (type === 'IDAT') data.push(chunk);
  else if (type === 'IEND') { if (length) return null; ended = true; }
  pos += length + 12;
 }
 if (!header || !ended || !data.length) return null;
 const expected = header.height * (1 + header.width * header.channels);
 let pixels: Buffer;
 try { pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected }); } catch { return null; }
 if (pixels.length !== expected) return null;
 for (let row = 0; row < expected; row += 1 + header.width * header.channels) if (pixels[row] > 4) return null;
 return { width: header.width, height: header.height };
}
export function decodeSignature(dataUrl: string): Buffer {
 const body = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
 if (!inspectSignaturePng(body)) throw new BadRequestException('Draw your signature again.');
 return body;
}
/** A trial embed at signing time, so nothing that cannot go into the signed copy is ever stored. */
export async function assertSignatureEmbeds(body: Buffer): Promise<void> {
 try { await (await PDFDocument.create()).embedPng(body); } catch { throw new BadRequestException('Draw your signature again.'); }
}
export function decodePdf(base64: string): Buffer {
 const body = Buffer.from(base64, 'base64');
 if (body.length > MAX_PDF_BYTES || body.subarray(0, 5).toString('latin1') !== '%PDF-') throw new BadRequestException('Upload a PDF file up to 3 MB.');
 return body;
}
