import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { HealthController } from '../src/modules/health/health.controller';
import { configureApp } from '../src/common/configure-app';
import { validateEnvironment } from '../src/config/environment';
import { databaseOptions } from '../src/database/options';

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
    const module = await Test.createTestingModule({ controllers: [HealthController], providers: [{ provide: DataSource, useValue: { query } }] }).compile();
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
