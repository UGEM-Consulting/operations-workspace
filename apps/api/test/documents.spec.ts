import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { PDFDocument } from 'pdf-lib';
import { EnvironmentError, validateEnvironment } from '../src/config/environment';
import { executedDocument, inspectPdf } from '../src/modules/documents/certificate';
import { applicantStatement } from '../src/modules/documents/statements';
import { ApplicantSignatureDto, MAX_SIGNATURE_BYTES } from '../src/modules/documents/documents.dto';
import { assertSignatureEmbeds, cleanJpeg, decodeJpeg, decodeSignature, inspectSignaturePng, MAX_PHOTO_SIDE, MAX_SIGNATURE_WIDTH } from '../src/modules/documents/images';
import { jpeg, pdfText, png, pngChunk, pngHeader, PNG_SIGNATURE } from './documents.fixtures';
import { StorageService } from '../src/modules/storage/storage.service';
import { allowedEndpoint, bodyLimit, isFileEndpoint } from '../../web/src/lib/bff-policy';
const base = { DATABASE_URL: 'postgresql://localhost/test', CORS_ORIGINS: 'https://workspace.example.test', WEB_ORIGIN: 'https://workspace.example.test', SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex') };
// A fictional, non-functional service-account shape; never a real key.
const key = Buffer.from(JSON.stringify({ type: 'service_account', project_id: 'fictional-project', client_email: 'uploader@fictional-project.example.test', private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n' })).toString('base64');
const gcs = { ...base, NODE_ENV: 'production', STORAGE_DRIVER: 'gcs', GCS_BUCKET: 'fictional-onboarding-files', GCS_CREDENTIALS_BASE64: key };
describe('document storage configuration', () => {
  it('accepts a private bucket in production and a local folder elsewhere', () => {
    expect(validateEnvironment(gcs)).toMatchObject({ STORAGE_DRIVER: 'gcs', GCS_BUCKET: 'fictional-onboarding-files' });
    expect(validateEnvironment({ ...base, NODE_ENV: 'test', STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: '.storage' }).STORAGE_DRIVER).toBe('local');
    expect(validateEnvironment({ ...base, NODE_ENV: 'test' }).STORAGE_DRIVER).toBe('none');
  });
  it.each([
    [{ STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: '.storage' }, 'Production storage'],
    [{ GCS_BUCKET: '' }, 'GCS_BUCKET'], [{ GCS_CREDENTIALS_BASE64: Buffer.from('{"type":"user"}').toString('base64') }, 'service-account'],
    [{ GCS_BUCKET: 'Invalid_Bucket!' }, 'GCS_BUCKET'],
  ])('rejects unsafe or incomplete production storage %#', (override, message) => { expect(() => validateEnvironment({ ...gcs, ...override })).toThrow(message); });
  it('keeps the real bucket out of development and tests, and requires a folder for local storage', () => {
    expect(() => validateEnvironment({ ...gcs, NODE_ENV: 'test' })).toThrow('Outside production');
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'test', STORAGE_DRIVER: 'local' })).toThrow('STORAGE_LOCAL_DIR');
  });
  it('never reveals the key in validation errors', () => {
    try { validateEnvironment({ ...gcs, GCS_BUCKET: '' }); throw new Error('expected rejection'); }
    catch (error) { expect(String(error)).not.toContain(key); expect(String(error)).not.toContain('not-a-key'); }
  });
  it('refuses to start the production API without the bucket, while operator commands keep working', () => {
    const production = { ...base, NODE_ENV: 'production' };
    expect(validateEnvironment(production).STORAGE_DRIVER).toBe('none');
    expect(() => new StorageService(new ConfigService(validateEnvironment(production)))).toThrow(EnvironmentError);
    expect(new StorageService(new ConfigService(validateEnvironment(gcs))).enabled).toBe(true);
    expect(new StorageService(new ConfigService(validateEnvironment({ ...base, NODE_ENV: 'test' }))).enabled).toBe(false);
  });
  it('lets staging run without a bucket, but never with local files or outside a hosted runtime', () => {
    const staging = { ...base, NODE_ENV: 'production', DEPLOYMENT_PURPOSE: 'staging' };
    expect(new StorageService(new ConfigService(validateEnvironment(staging))).enabled).toBe(false);
    expect(new StorageService(new ConfigService(validateEnvironment({ ...gcs, DEPLOYMENT_PURPOSE: 'staging' }))).enabled).toBe(true);
    expect(() => validateEnvironment({ ...staging, STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: '.storage' })).toThrow('Production storage');
    expect(() => validateEnvironment({ ...staging, NODE_ENV: 'development' })).toThrow('requires NODE_ENV=production');
    expect(() => validateEnvironment({ ...staging, WEB_ORIGIN: 'http://staging.example.test' })).toThrow('HTTPS');
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'production', DEPLOYMENT_PURPOSE: 'local' })).toThrow('production or staging');
  });
});
describe('signed copies', () => {
  it('appends a certificate after the unchanged original pages', async () => {
    const original = await PDFDocument.create(); original.addPage(); original.addPage();
    const bytes = Buffer.from(await original.save());
    expect(await inspectPdf(bytes)).toBe(2);
    await expect(inspectPdf(Buffer.from('%PDF-1.7 broken'))).rejects.toThrow();
    const statement = applicantStatement({ kind: 'SOP', title: 'Fictional SOP — rev 1', version: 3 });
    expect(statement.statement).toContain('version 3'); expect(statement.translatedStatement).toContain('версия 3');
    const signed = await executedDocument(bytes, { title: 'Fictional SOP — rev 1', version: 3, sha256: 'a'.repeat(64) }, '00000000-0000-0000-0000-000000000000', [
      { signerRole: 'APPLICANT', typedName: 'Fictional Applicant', signedAt: new Date(), ipAddress: '203.0.113.7', userAgent: 'Fictional Browser', consent: 'Consent', ...statement, signatureImage: null, firstViewedAt: new Date() },
    ]);
    expect((await PDFDocument.load(signed)).getPageCount()).toBe(3);
  });
});
describe('document routes through the BFF', () => {
  it('allows only the implemented upload, signing and file routes', () => {
    const id = '00000000-0000-0000-0000-000000000000';
    for (const [method, path] of [['GET', 'documents'], ['POST', 'documents'], ['GET', `documents/${id}/file`], ['POST', 'applicant/photos/selfie'], ['GET', 'applicant/photos/id-selfie'],
      ['GET', `applicant/documents/${id}/file`], ['POST', `applicant/documents/${id}/view`], ['POST', `applicant/documents/${id}/sign`], ['GET', `applicant/documents/${id}/signed`],
      ['GET', `onboarding/applications/${id}/photos/id-selfie`], ['GET', `onboarding/applications/${id}/documents/${id}/signed`], ['GET', `it/onboarding/${id}/photo`]]) expect(allowedEndpoint(method, path)).toBe(true);
    for (const [method, path] of [['POST', 'applicant/photos/passport'], ['GET', `it/onboarding/${id}/photos/id-selfie`], ['PATCH', 'documents'], ['GET', `documents/${id}/file/../../users`], ['POST', `documents/${id}/file`], ['GET', `applicant/documents/${id}/view`]]) expect(allowedEndpoint(method, path)).toBe(false);
    expect(isFileEndpoint(`it/onboarding/${id}/photo`)).toBe(true); expect(isFileEndpoint('applicant/application')).toBe(false);
    expect(bodyLimit('applicant/photos/selfie')).toBeLessThan(4_500_000); expect(bodyLimit(`applicant/documents/${id}/sign`)).toBe(400_000); expect(bodyLimit('auth/login')).toBe(16384);
  });
});
describe('signature images', () => {
  const dataUrl = (body: Buffer) => `data:image/png;base64,${body.toString('base64')}`;
  it('accepts a pad-sized RGBA PNG that pdf-lib can embed', async () => {
    const body = png(600, 180);
    expect(inspectSignaturePng(body)).toEqual({ width: 600, height: 180 });
    expect(decodeSignature(dataUrl(body)).equals(body)).toBe(true);
    await expect(assertSignatureEmbeds(body)).resolves.toBeUndefined();
  });
  it('rejects a tiny PNG that would decode into a huge bitmap, without inflating it', () => {
    // A few KB on the wire, but 16000 x 16000 RGBA (1 GB) once decoded.
    const bomb = Buffer.concat([PNG_SIGNATURE, pngHeader(16000, 16000), pngChunk('IDAT', deflateSync(Buffer.alloc(4_000_000))), pngChunk('IEND', Buffer.alloc(0))]);
    expect(bomb.length).toBeLessThan(MAX_SIGNATURE_BYTES);
    expect(inspectSignaturePng(bomb)).toBeNull();
    expect(() => decodeSignature(dataUrl(bomb))).toThrow(BadRequestException);
    expect(inspectSignaturePng(png(MAX_SIGNATURE_WIDTH + 1, 10))).toBeNull();
  });
  it.each([
    ['an animated PNG', () => png(60, 20, { extra: [pngChunk('acTL', Buffer.alloc(8))] })],
    ['a corrupted chunk CRC', () => { const body = png(); body[body.length - 20] ^= 0xff; return body; }],
    ['a missing IEND', () => png().subarray(0, -12)],
    ['data after IEND', () => Buffer.concat([png(), Buffer.from('trailing')])],
    ['IHDR not first', () => { const body = png(); return Buffer.concat([PNG_SIGNATURE, pngChunk('tEXt', Buffer.from('a\0b')), body.subarray(8)]); }],
    ['16-bit samples', () => Buffer.concat([PNG_SIGNATURE, pngHeader(60, 20, 16, 6), png().subarray(33)])],
    ['a palette image', () => Buffer.concat([PNG_SIGNATURE, pngHeader(60, 20, 8, 3), png().subarray(33)])],
    ['image data of the wrong size', () => png(60, 20, { idat: deflateSync(Buffer.alloc(100)) })],
    ['image data that is not zlib', () => png(60, 20, { idat: randomBytes(500) })],
    ['an unknown critical chunk', () => png(60, 20, { extra: [pngChunk('ZZZZ', Buffer.alloc(4))] })],
    ['a JPEG', () => jpeg()],
  ])('rejects %s', (_name, build) => {
    const body = build();
    expect(inspectSignaturePng(body)).toBeNull();
    expect(() => decodeSignature(dataUrl(body))).toThrow(BadRequestException);
  });
  it('accepts signatureMethod DRAWN or TYPED only, and it is optional', async () => {
    const base = { typedName: 'Fictional Signer', agreed: true, consent: true };
    expect(await validate(plainToInstance(ApplicantSignatureDto, { ...base, signatureMethod: 'TYPED' }))).toHaveLength(0);
    expect(await validate(plainToInstance(ApplicantSignatureDto, base))).toHaveLength(0);
    expect(await validate(plainToInstance(ApplicantSignatureDto, { ...base, signatureMethod: 'STAMPED' }))).not.toHaveLength(0);
  });
});
describe('photo metadata stripping', () => {
  it('drops EXIF, comments and trailing data but keeps the JFIF header, frame and scan', () => {
    const original = jpeg(), cleaned = cleanJpeg(original);
    const text = cleaned.toString('latin1');
    expect(text).not.toContain('Exif'); expect(text).not.toContain('GPS'); expect(text).not.toContain('fictional comment'); expect(text).not.toContain('TRAILING');
    expect(text).toContain('JFIF');
    expect(cleaned.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); expect(cleaned.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    const plain = jpeg({ exif: false, trailing: false });
    expect(cleanJpeg(plain).equals(plain)).toBe(true);
    expect(cleanJpeg(cleaned).equals(cleaned)).toBe(true);
    expect(decodeJpeg(original.toString('base64')).length).toBe(cleaned.length);
  });
  it.each([
    ['no start marker', () => jpeg().subarray(2)],
    ['no scan', () => jpeg({ scan: false })],
    ['no end marker', () => jpeg({ eoi: false, trailing: false })],
    ['a truncated segment', () => jpeg().subarray(0, 40)],
    ['a segment length past the end', () => { const body = jpeg(); body.writeUInt16BE(0xfff0, 4); return body; }],
    ['random bytes after the start marker', () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(4000)])],
  ])('rejects a malformed JPEG with %s', (_name, build) => { expect(() => cleanJpeg(build())).toThrow(BadRequestException); });
  it('caps the dimensions declared by the frame', () => {
    expect(() => cleanJpeg(jpeg({ width: MAX_PHOTO_SIDE + 1 }))).toThrow('pixels per side');
    expect(() => cleanJpeg(jpeg({ height: 0 }))).toThrow(BadRequestException);
    expect(cleanJpeg(jpeg({ width: MAX_PHOTO_SIDE, height: MAX_PHOTO_SIDE })).length).toBeGreaterThan(1000);
  });
});
describe('signature certificate', () => {
  const statement = applicantStatement({ kind: 'NDA', title: 'Fictional NDA', version: 1 });
  const signatures = () => [
    { signerRole: 'APPLICANT' as const, typedName: 'Fictional Applicant', signedAt: new Date(), ipAddress: '203.0.113.7', userAgent: 'Fictional Applicant Browser', consent: 'Consent', ...statement, signatureImage: png(600, 180), signatureMethod: 'TYPED' as const, firstViewedAt: new Date() },
    { signerRole: 'COMPANY' as const, typedName: 'Fictional Manager', signedAt: new Date(), ipAddress: '198.51.100.4', userAgent: 'Fictional Manager Browser', consent: null, statement: 'Countersigned', translatedStatement: null, signatureImage: png(600, 180), signatureMethod: null, firstViewedAt: null },
  ];
  const original = async () => { const pdf = await PDFDocument.create(); pdf.addPage(); return Buffer.from(await pdf.save()); };
  const doc = { title: 'Fictional NDA', version: 1, sha256: 'b'.repeat(64) }, reference = '00000000-0000-0000-0000-000000000000';
  it('shows the signature method, and hides the countersigner IP and browser on the applicant copy only', async () => {
    const bytes = await original();
    const staff = pdfText(await executedDocument(bytes, doc, reference, signatures(), 'staff'));
    const applicant = pdfText(await executedDocument(bytes, doc, reference, signatures(), 'applicant'));
    expect(staff).toContain('Signature adopted from the typed name'); expect(staff).toContain('Drawn signature');
    expect(staff).toContain('198.51.100.4'); expect(staff).toContain('Fictional Manager Browser');
    expect(applicant).not.toContain('198.51.100.4'); expect(applicant).not.toContain('Fictional Manager Browser');
    expect(applicant).toContain('Recorded by UGEM'); expect(applicant).toContain('203.0.113.7');
    expect(applicant).toContain('opened the full document from the signing page');
  });
  it('never decodes a stored image that fails the structural check', async () => {
    const bomb = Buffer.concat([PNG_SIGNATURE, pngHeader(16000, 16000), pngChunk('IDAT', deflateSync(Buffer.alloc(1000))), pngChunk('IEND', Buffer.alloc(0))]);
    const [applicant] = signatures();
    expect(pdfText(await executedDocument(await original(), doc, reference, [{ ...applicant, signatureImage: bomb }]))).toContain('cannot be shown in this copy');
  });
});
