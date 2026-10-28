import { SafeExceptionFilter } from './safe-exception.filter';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { json, type NextFunction, type Request, type Response } from 'express';
// Photo, PDF and signature uploads (including a saved staff signature) are base64 JSON. Only these routes accept bodies above the 100 kB default;
// the BFF separately caps requests below the hosting limit.
const UPLOAD_ROUTES = ['/api/applicant/photos', '/api/applicant/documents', '/api/documents', '/api/onboarding/applications', '/api/staff/signature'];
const uploadJson = json({ limit: '5mb' });
/**
 * Baseline headers on every API response (no extra dependency). Cache-Control is a default that routes replace when they
 * set their own, such as private file responses. Also applied by the session boundary, which can answer before this runs.
 */
export function setSecurityHeaders(res: Response): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}
export function configureApp(app: INestApplication, origins: string): void {
  (app.getHttpAdapter().getInstance() as { disable(setting: string): void }).disable('x-powered-by');
  app.use((_req: Request, res: Response, next: NextFunction) => { setSecurityHeaders(res); next(); });
  // Named wrapper: Nest skips its own JSON parser if it finds a middleware named jsonParser.
  app.use(UPLOAD_ROUTES, function uploadBodyParser(req: Request, res: Response, next: NextFunction) { uploadJson(req, res, next); });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new SafeExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({ origin: origins.split(',').map((origin) => origin.trim()), credentials: false });
  app.enableShutdownHooks();
}
