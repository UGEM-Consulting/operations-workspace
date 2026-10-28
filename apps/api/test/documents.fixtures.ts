import { randomBytes } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
// Fictional, structurally valid test images built byte by byte; no real photos or signatures.
export function pngChunk(type: string, data: Buffer) {
 const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
 length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
 return Buffer.concat([length, body, crc]);
}
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function pngHeader(width: number, height: number, depth = 8, colour = 6) {
 const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([depth, colour, 0, 0, 0], 8);
 return pngChunk('IHDR', header);
}
export function png(width = 60, height = 20, { extra = [] as Buffer[], idat = undefined as Buffer | undefined } = {}) {
 // Mostly transparent like a real signature, with a few random "ink" pixels per row.
 const rows = Buffer.concat(Array.from({ length: height }, () => { const row = Buffer.alloc(1 + width * 4); randomBytes(Math.min(40, width * 4)).copy(row, 1); return row; }));
 return Buffer.concat([PNG_SIGNATURE, pngHeader(width, height), ...extra, pngChunk('IDAT', idat ?? deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
const segment = (marker: number, data: Buffer) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(data.length + 2, 2); return Buffer.concat([head, data]); };
/** A JPEG-shaped file: JFIF, an EXIF segment with fictional GPS text, a comment, frame, scan, EOI and trailing bytes. */
export function jpeg({ width = 640, height = 480, exif = true, scan = true, eoi = true, trailing = true } = {}) {
 const frame = Buffer.alloc(15); frame[0] = 8; frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3); frame[5] = 3;
 frame.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 6);
 const entropy = randomBytes(3000).map(byte => byte === 0xff ? 0 : byte);
 return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
  ...(exif ? [segment(0xe1, Buffer.from('Exif\0\0GPS 41.8781N 87.6298W FictionalCamera', 'latin1')), segment(0xfe, Buffer.from('fictional comment', 'latin1'))] : []),
  segment(0xdb, Buffer.alloc(65, 1)), segment(0xc0, frame), segment(0xc4, Buffer.alloc(30, 0)),
  ...(scan ? [segment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0])), Buffer.from(entropy), Buffer.from([0xff, 0xd0]), Buffer.from(entropy.subarray(0, 100))] : []),
  ...(eoi ? [Buffer.from([0xff, 0xd9])] : []), ...(trailing ? [Buffer.from('TRAILING-FICTIONAL-DATA', 'latin1')] : [])]);
}
/** Text drawn with pdf-lib's standard fonts, recovered from the (deflated) content streams of a PDF. */
export function pdfText(pdf: Buffer): string {
 const text: string[] = [], source = pdf.toString('latin1');
 for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
  let content = match[1];
  try { content = inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'); } catch { /* not compressed */ }
  for (const hex of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) text.push(Buffer.from(hex[1], 'hex').toString('latin1'));
  for (const literal of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) text.push(literal[1]);
 }
 return text.join('\n');
}
