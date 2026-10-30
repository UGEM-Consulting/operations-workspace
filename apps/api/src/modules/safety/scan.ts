import { BadRequestException } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { decodeJpeg } from '../documents/images';

/** Up to four photographed pages per document, and what one upload may carry in total (under the BFF's 4.4 MB body limit). */
export const MAX_SCAN_PAGES = 4, MAX_SCAN_BYTES = 3_200_000;
// The longest side of a page in PDF points (11 inches): a scan prints at about letter size.
const PAGE_SIDE = 792, MAX_PAGE_RATIO = 4;

/**
 * Combines photographed pages (base64 JPEGs) into one PDF, one page per photo. Each photo is checked and rewritten
 * without metadata first (decodeJpeg), so no camera location or comments reach storage.
 */
export async function scanPdf(pages: string[]): Promise<Buffer> {
 const photos = pages.map(decodeJpeg);
 if (photos.reduce((total, photo) => total + photo.length, 0) > MAX_SCAN_BYTES) throw new BadRequestException('These pages are too large together. Retake them or scan fewer pages at once.');
 const pdf = await PDFDocument.create();
 pdf.setProducer('UGEM Workspace'); pdf.setCreator('UGEM Workspace');
 for (const photo of photos) {
  let image;
  // A plain Uint8Array: pdf-lib's type check can reject a Buffer from another realm (as under the test runner).
  try { image = await pdf.embedJpg(new Uint8Array(photo)); } catch { throw new BadRequestException('A page could not be read. Take the photo again.'); }
  // A sliver of a photo would make a page too thin for PDF viewers (under 3 points) and shows no document anyway.
  if (Math.max(image.width, image.height) > MAX_PAGE_RATIO * Math.min(image.width, image.height)) throw new BadRequestException('A page is too narrow. Photograph the whole document.');
  const scale = PAGE_SIDE / Math.max(image.width, image.height);
  const page = pdf.addPage([image.width * scale, image.height * scale]);
  page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
 }
 return Buffer.from(await pdf.save({ updateFieldAppearances: false }));
}
