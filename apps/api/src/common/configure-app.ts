import { SafeExceptionFilter } from './safe-exception.filter';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { json, type NextFunction, type Request, type Response } from 'express';
// Photo, PDF and drawn-signature uploads are base64 JSON. Only these routes accept bodies above the 100 kB default;
// the BFF separately caps requests below the hosting limit.
const UPLOAD_ROUTES = ['/api/applicant/photos', '/api/applicant/documents', '/api/documents', '/api/onboarding/applications'];
const uploadJson = json({ limit: '5mb' });
export function configureApp(app: INestApplication, origins: string): void {
  // Named wrapper: Nest skips its own JSON parser if it finds a middleware named jsonParser.
  app.use(UPLOAD_ROUTES, function uploadBodyParser(req: Request, res: Response, next: NextFunction) { uploadJson(req, res, next); });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new SafeExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({ origin: origins.split(',').map((origin) => origin.trim()), credentials: false });
  app.enableShutdownHooks();
}
