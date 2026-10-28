import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, Header, INestApplication, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { HealthController } from '../src/modules/health/health.controller';
import { configureApp } from '../src/common/configure-app';
import { validateEnvironment } from '../src/config/environment';
import { databaseOptions } from '../src/database/options';

// Stand-in for private file routes, which set their own caching headers.
@Controller('files-probe')
class FileProbeController {
  @Get('decorated') @Header('Cache-Control', 'private, no-store, max-age=0') decorated() { return 'file'; }
  @Post('echo') echo(@Body() body: unknown) { return { received: typeof body }; }
  @Get('manual') manual(@Res() res: Response) { res.setHeader('Cache-Control', 'private, no-cache'); res.type('application/pdf').send(Buffer.from('%PDF')); }
}
const environment = { SESSION_SECRET: randomBytes(32).toString('hex'), BFF_SHARED_SECRET: randomBytes(32).toString('hex'), WEB_ORIGIN: 'https://workspace.example.test', DATABASE_URL: 'postgresql://local:local@localhost:5432/test', CORS_ORIGINS: 'http://localhost:3000' };

describe('Environment and database safety', () => {
  it('requires a PostgreSQL connection URL', () => {
    expect(() => validateEnvironment({ CORS_ORIGINS: 'http://localhost:3000' })).toThrow();
    expect(() => validateEnvironment({ ...environment, DATABASE_URL: 'https://example.com' })).toThrow();
  });
  it('rejects invalid ports and wildcard CORS', () => {
    expect(() => validateEnvironment({ ...environment, PORT: 99999 })).toThrow();
    expect(() => validateEnvironment({ ...environment, CORS_ORIGINS: '*' })).toThrow();
    expect(() => validateEnvironment({ ...environment, CORS_ORIGINS: 'https://*.example.test' })).toThrow();
  });
  it('parses booleans and disables automatic schema changes in production', () => {
    const config = validateEnvironment({ ...environment, NODE_ENV: 'production', DATABASE_SSL: 'false' });
    expect(config.DATABASE_SSL).toBe(false);
    expect(databaseOptions(config)).toMatchObject({ synchronize: false, migrationsRun: false, ssl: false });
    expect(databaseOptions({ ...config, DATABASE_SSL: true })).toMatchObject({ ssl: { rejectUnauthorized: true } });
  });
});

describe('Health HTTP endpoint', () => {
  let app: INestApplication;
  const query = jest.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [HealthController, FileProbeController], providers: [{ provide: DataSource, useValue: { query } }] }).compile();
    app = module.createNestApplication();
    configureApp(app, environment.CORS_ORIGINS);
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  it('returns healthy when PostgreSQL responds', async () => {
    query.mockResolvedValueOnce([{ '?column?': 1 }]);
    await request(app.getHttpServer()).get('/api/health').expect(200).expect({ status: 'ok', service: 'operations-api', database: 'connected' });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });
  it('sends baseline security headers and hides the framework', async () => {
    query.mockResolvedValueOnce([{ '?column?': 1 }]);
    const response = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(response.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin', 'cache-control': 'no-store' });
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
  it('lets routes that set their own caching headers keep them', async () => {
    expect((await request(app.getHttpServer()).get('/api/files-probe/decorated').expect(200)).headers['cache-control']).toBe('private, no-store, max-age=0');
    const manual = await request(app.getHttpServer()).get('/api/files-probe/manual').expect(200);
    expect(manual.headers).toMatchObject({ 'cache-control': 'private, no-cache', 'content-type': 'application/pdf', 'x-content-type-options': 'nosniff' });
  });
  it('answers malformed and oversized JSON bodies with fixed 4xx messages instead of a server error', async () => {
    const malformed = await request(app.getHttpServer()).post('/api/files-probe/echo').set('Content-Type', 'application/json').send('{"broken":').expect(400);
    expect(malformed.body.statusCode).toBe(400);
    const large = await request(app.getHttpServer()).post('/api/files-probe/echo').set('Content-Type', 'application/json').send(JSON.stringify({ text: 'x'.repeat(200_000) })).expect(413);
    expect(large.body).toEqual({ statusCode: 413, message: 'Request body too large' });
  });
  it('returns 503 without leaking database errors', async () => {
    query.mockRejectedValueOnce(new Error('sensitive connection details'));
    const result = await request(app.getHttpServer()).get('/api/health').expect(503);
    expect(result.text).not.toContain('sensitive');
  });
  it('allows only configured browser origins', async () => {
    const allowed = await request(app.getHttpServer()).options('/api/health').set('Origin', 'http://localhost:3000').set('Access-Control-Request-Method', 'GET').expect(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const denied = await request(app.getHttpServer()).options('/api/health').set('Origin', 'https://untrusted.example').set('Access-Control-Request-Method', 'GET');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
