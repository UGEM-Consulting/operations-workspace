import { ItModule } from './modules/it/it.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { AuthModule } from './modules/auth/auth.module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnvironment } from './config/environment';
import { databaseOptions } from './database/options';
import { HealthModule } from './modules/health/health.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';
import { ListsModule } from './modules/lists/lists.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { SafetyModule } from './modules/safety/safety.module';
@Module({ imports: [
  ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
  TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({
    ...databaseOptions(validateEnvironment({ NODE_ENV: config.get('NODE_ENV'), PORT: config.get('PORT'),
      DATABASE_URL: config.get('DATABASE_URL'), DATABASE_SSL: config.get('DATABASE_SSL'),
      CORS_ORIGINS: config.get('CORS_ORIGINS'), SESSION_SECRET: config.get('SESSION_SECRET'), BFF_SHARED_SECRET: config.get('BFF_SHARED_SECRET'), WEB_ORIGIN: config.get('WEB_ORIGIN'), SESSION_TTL_SECONDS: config.get('SESSION_TTL_SECONDS'),
      DEPLOYMENT_PURPOSE: config.get('DEPLOYMENT_PURPOSE') })), retryAttempts: 3,
  }) }), HealthModule, AuthModule, OnboardingModule, ItModule, DocumentsModule, WorkspaceModule, ListsModule, DispatchModule, SafetyModule,
] })
export class AppModule {}
