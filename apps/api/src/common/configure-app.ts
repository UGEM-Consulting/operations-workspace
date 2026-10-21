import { SafeExceptionFilter } from './safe-exception.filter';
import { INestApplication, ValidationPipe } from '@nestjs/common';
export function configureApp(app: INestApplication, origins: string): void {
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new SafeExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({ origin: origins.split(',').map((origin) => origin.trim()), credentials: false });
  app.enableShutdownHooks();
}
