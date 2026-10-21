import { ItModule } from './modules/it/it.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { AuthModule } from './modules/auth/auth.module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnvironment } from './config/environment';
import { databaseOptions } from './database/options';
import { HealthModule } from './modules/health/health.module';
@Module({ imports: [
  ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
  TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({
    ...databaseOptions(validateEnvironment({ NODE_ENV: config.get('NODE_ENV'), PORT: config.get('PORT'),
      DATABASE_URL: config.get('DATABASE_URL'), DATABASE_SSL: config.get('DATABASE_SSL'),
      CORS_ORIGINS: config.get('CORS_ORIGINS'), SESSION_SECRET: config.get('SESSION_SECRET'), BFF_SHARED_SECRET: config.get('BFF_SHARED_SECRET'), WEB_ORIGIN: config.get('WEB_ORIGIN'), SESSION_TTL_SECONDS: config.get('SESSION_TTL_SECONDS') })), retryAttempts: 3,
  }) }), HealthModule, AuthModule, OnboardingModule, ItModule,
] })
export class AppModule {}
