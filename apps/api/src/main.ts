import { installSessions } from './modules/auth/session';
import { validateEnvironment } from './config/environment';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './common/configure-app';
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const closeSessions = installSessions(app, validateEnvironment(process.env));
  const originalClose = app.close.bind(app);
  app.close = async () => { await closeSessions(); await originalClose(); };
  configureApp(app, config.getOrThrow<string>('CORS_ORIGINS'));
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Operations Workspace API')
    .setDescription('Internal identity and infrastructure endpoints').setVersion('1.0').build());
  SwaggerModule.setup('api/docs', app, document);
  await app.listen(config.getOrThrow<number>('PORT'), '0.0.0.0');
}
void bootstrap();
