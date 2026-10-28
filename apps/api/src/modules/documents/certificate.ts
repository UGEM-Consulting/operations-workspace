import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { inspectSignaturePng } from './images';
export interface CertificateSignature {
 signerRole:'APPLICANT'|'COMPANY';typedName:string;signedAt:Date;ipAddress:string|null;userAgent:string|null;signatureMethod?:'DRAWN'|'TYPED'|null;fromSavedSignature?:boolean;
 statement:string;translatedStatement:string|null;consent:string|null;signatureImage:Buffer|null;firstViewedAt:Date|null;
}
export interface CertificateDocument {title:string;version:number;sha256:string;}
/** Validates an uploaded company document: an unencrypted, readable PDF. Returns its page count. */
export async function inspectPdf(file: Buffer): Promise<number> {
 const pdf = await PDFDocument.load(file, { updateMetadata: false });
 return pdf.getPageCount();
}
// Standard PDF fonts cover Latin-1 only; typed names are restricted to Latin letters, other text is ASCII.
const latin = (text: string) => text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
function lines(text: string, font: PDFFont, size: number, width: number): string[] {
 const result: string[] = [];
 for (const paragraph of latin(text).split('\n')) {
  let line = '';
  for (const word of paragraph.split(' ')) {
   const next = line ? `${line} ${word}` : word;
   if (font.widthOfTextAtSize(next, size) <= width || !line) line = next; else { result.push(line); line = word; }
  }
  result.push(line);
 }
 return result;
}
/**
 * The executed copy: the original document, unchanged, followed by an electronic signature certificate with each
 * signer's typed name, signature image, statement, consent, time, IP address, browser and the document fingerprint.
 * The applicant's copy leaves out the company countersigner's IP address and browser; staff copies include them.
 */
export async function executedDocument(original: Buffer, doc: CertificateDocument, applicationId: string, signatures: CertificateSignature[], audience: 'applicant'|'staff' = 'staff'): Promise<Buffer> {
 const pdf = await PDFDocument.load(original, { updateMetadata: false });
 const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
 const margin = 54, width = 612 - margin * 2;
 let page: PDFPage = pdf.addPage([612, 792]), y = 792 - margin;
 const space = (height: number) => { if (y - height < margin) { page = pdf.addPage([612, 792]); y = 792 - margin; } };
 const write = (text: string, options: { size?: number; font?: PDFFont; gap?: number } = {}) => {
  const size = options.size ?? 9, font = options.font ?? regular;
  for (const line of lines(text, font, size, width)) { space(size + 3); page.drawText(line, { x: margin, y: y - size, size, font, color: rgb(0.1, 0.1, 0.1) }); y -= size + 3; }
  y -= options.gap ?? 4;
 };
 write('Electronic Signature Certificate', { size: 16, font: bold, gap: 10 });
 write(`Document: ${doc.title} (version ${doc.version})`);
 write(`SHA-256 fingerprint of the signed document: ${doc.sha256}`);
 write(`Application reference: ${applicationId}`);
 write('The pages before this certificate are the exact document that was signed. Its fingerprint above can be recomputed to confirm it has not changed.', { gap: 14 });
 for (const signature of signatures) {
  space(140);
  write(signature.signerRole === 'APPLICANT' ? 'Signer' : 'Countersigner on behalf of the company', { size: 12, font: bold });
  write(`Name: ${signature.typedName}`);
  write(`Signed: ${signature.signedAt.toISOString()} (UTC)`);
  if (signature.firstViewedAt) write(`Signer first opened the full document from the signing page: ${signature.firstViewedAt.toISOString()} (UTC)`);
  if (audience === 'applicant' && signature.signerRole === 'COMPANY') write('IP address and browser: Recorded by UGEM');
  else { write(`IP address: ${signature.ipAddress ?? 'Not recorded'}`); write(`Browser: ${signature.userAgent ?? 'Not recorded'}`); }
  if (signature.consent) write(`Electronic records consent: ${signature.consent}`);
  write(`Statement agreed to: ${signature.statement}`);
  if (signature.translatedStatement) write('A Russian translation of this statement was displayed with it; the English text governs.');
  // Only structurally checked images are decoded: an oversized bitmap could exhaust the API's memory.
  if (signature.signatureImage && !inspectSignaturePng(signature.signatureImage)) {
   write('The signature image is kept in the signature record but cannot be shown in this copy.');
  } else if (signature.signatureImage) {
   const image = await pdf.embedPng(signature.signatureImage);
   const scale = Math.min(220 / image.width, 70 / image.height, 1);
   space(image.height * scale + 16);
   page.drawImage(image, { x: margin, y: y - image.height * scale, width: image.width * scale, height: image.height * scale });
   y -= image.height * scale + 4;
   page.drawLine({ start: { x: margin, y }, end: { x: margin + 220, y }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) });
   y -= 6;
   write((signature.signatureMethod === 'TYPED' ? 'Signature adopted from the typed name' : 'Drawn signature') + (signature.fromSavedSignature ? ', applied from their saved signature' : ''), { size: 8 });
  } else {
   write('Acknowledged by checkbox (no signature required for this document).');
  }
  y -= 10;
 }
 return Buffer.from(await pdf.save());
}
