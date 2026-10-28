import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PDFDocument } from 'pdf-lib';
import { EnvironmentError, validateEnvironment } from '../src/config/environment';
import { executedDocument, inspectPdf } from '../src/modules/documents/certificate';
import { applicantStatement } from '../src/modules/documents/statements';
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
      ['GET', `applicant/documents/${id}/file`], ['POST', `applicant/documents/${id}/sign`], ['GET', `applicant/documents/${id}/signed`],
      ['GET', `onboarding/applications/${id}/photos/id-selfie`], ['GET', `onboarding/applications/${id}/documents/${id}/signed`], ['GET', `it/onboarding/${id}/photo`]]) expect(allowedEndpoint(method, path)).toBe(true);
    for (const [method, path] of [['POST', 'applicant/photos/passport'], ['GET', `it/onboarding/${id}/photos/id-selfie`], ['PATCH', 'documents'], ['GET', `documents/${id}/file/../../users`], ['POST', `documents/${id}/file`]]) expect(allowedEndpoint(method, path)).toBe(false);
    expect(isFileEndpoint(`it/onboarding/${id}/photo`)).toBe(true); expect(isFileEndpoint('applicant/application')).toBe(false);
    expect(bodyLimit('applicant/photos/selfie')).toBeLessThan(4_500_000); expect(bodyLimit(`applicant/documents/${id}/sign`)).toBe(400_000); expect(bodyLimit('auth/login')).toBe(16384);
  });
});
