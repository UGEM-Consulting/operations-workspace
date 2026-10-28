import { installSessions } from './modules/auth/session';
import { validateEnvironment } from './config/environment';
import 'reflect-metadata';
import { ConsoleLogger, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './common/configure-app';
import { startupFailureReason } from './startup-failure';

/** Production logs keep the first line of string messages only; error objects and stack traces can carry database hosts. */
export class SafeLogger extends ConsoleLogger {
  error(message: unknown, ...optional: unknown[]) {
    const context = optional[optional.length - 1];
    super.error(typeof message === 'string' ? message.split('\n')[0] : 'Error details suppressed', ...(typeof context === 'string' && !context.includes('\n') ? [context] : []));
  }
}

export async function bootstrap(): Promise<void> {
  const production = process.env.NODE_ENV === 'production';
  // abortOnError: false rejects instead of aborting the process, so callers can report a sanitised reason.
  const app = await NestFactory.create(AppModule, { abortOnError: false, ...(production ? { logger: new SafeLogger() } : {}) });
  try {
    await start(app);
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

async function start(app: INestApplication): Promise<void> {
  const config = app.get(ConfigService);
  const env = validateEnvironment(process.env);
  const closeSessions = installSessions(app, env);
  const originalClose = app.close.bind(app);
  app.close = async () => { await closeSessions(); await originalClose(); };
  configureApp(app, config.getOrThrow<string>('CORS_ORIGINS'));
  // API documentation is a development aid only; production does not publish the route inventory.
  if (env.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('UGEM Workspace API')
      .setDescription('Internal identity and infrastructure endpoints').setVersion('1.0').build());
    SwaggerModule.setup('api/docs', app, document);
  }
  await app.listen(config.getOrThrow<number>('PORT'), '0.0.0.0');
}

// `npm start` / `nest start` run this file directly; start-render imports it and awaits bootstrap itself.
if (require.main === module) void bootstrap().catch((error: unknown) => {
  console.error(`API startup failed: ${startupFailureReason(error)}`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 5000).unref();
});
