import { randomBytes } from 'node:crypto';
import { backendFailureCode, readBackendConfig } from '../../web/src/lib/backend-connection';

const environment = { NODE_ENV: 'production', API_BASE_URL: 'https://api.example.test', WEB_ORIGIN: 'https://workspace.example.test', BFF_SHARED_SECRET: randomBytes(32).toString('hex') };
describe('Frontend backend connection configuration and safe diagnostics', () => {
  it('accepts HTTPS origins and normalizes harmless URL whitespace/trailing slashes', () => {
    const config = readBackendConfig({ ...environment, API_BASE_URL: ' https://api.example.test/ ', WEB_ORIGIN: 'https://workspace.example.test/' });
    expect(config.base).toBe(environment.API_BASE_URL);
    expect(config.origin).toBe(environment.WEB_ORIGIN);
  });
  it('accepts a comma-separated WEB_ORIGIN list with the first as primary', () => {
    const config = readBackendConfig({ ...environment, WEB_ORIGIN: ' https://workspace.ugemconsulting.com/ , https://workspace.example.test ' });
    expect(config.origin).toBe('https://workspace.ugemconsulting.com');
    expect(config.origins).toEqual(['https://workspace.ugemconsulting.com', 'https://workspace.example.test']);
    for (const value of ['https://a.example.test,http://b.example.test', 'https://a.example.test,https://a.example.test', 'https://a.example.test,', 'https://a.example.test,https://b.example.test/app', 'https://*.example.test']) {
      try { readBackendConfig({ ...environment, WEB_ORIGIN: value }); throw new Error('expected rejection'); }
      catch (error) { expect(backendFailureCode(error)).toBe('WEB_ORIGIN_INVALID'); }
    }
  });
  it.each(['API_BASE_URL', 'BFF_SHARED_SECRET', 'WEB_ORIGIN'])('identifies missing %s without logging environment values', key => {
    try { readBackendConfig({ ...environment, [key]: '' }); throw new Error('expected rejection'); }
    catch (error) { expect(backendFailureCode(error)).toBe(`${key}_MISSING`); }
  });
  it.each(['http://api.example.test', 'https://api.example.test/api', 'https://api.example.test?key=private', 'https://user:private@api.example.test', 'invalid'])('rejects unsafe or incorrectly structured backend origins', value => {
    try { readBackendConfig({ ...environment, API_BASE_URL: value }); throw new Error('expected rejection'); }
    catch (error) { expect(backendFailureCode(error)).toBe('API_BASE_URL_INVALID'); }
  });
  it('allows localhost HTTP in development only', () => {
    expect(readBackendConfig({ ...environment, NODE_ENV: 'development', API_BASE_URL: 'http://localhost:4000', WEB_ORIGIN: 'http://localhost:3000' }).base).toBe('http://localhost:4000');
  });
  it.each(['short', environment.BFF_SHARED_SECRET + '\n', ' ' + environment.BFF_SHARED_SECRET, environment.BFF_SHARED_SECRET + 'é'])('rejects secrets that cannot safely be sent in headers', value => {
    try { readBackendConfig({ ...environment, BFF_SHARED_SECRET: value }); throw new Error('expected rejection'); }
    catch (error) { expect(backendFailureCode(error)).toBe('BFF_SHARED_SECRET_INVALID'); }
  });
  it('classifies timeouts and network failures without including raw exception text', () => {
    const secret = randomBytes(32).toString('hex');
    expect(backendFailureCode(new DOMException(secret, 'TimeoutError'))).toBe('BACKEND_TIMEOUT');
    expect(backendFailureCode(new Error(secret, { cause: { code: 'ENOTFOUND', message: secret } }))).toBe('ENOTFOUND');
    expect(backendFailureCode(new Error(secret, { cause: { code: secret } }))).toBe('BACKEND_REQUEST_FAILED');
    expect(backendFailureCode(secret)).toBe('BACKEND_REQUEST_FAILED');
  });
});
