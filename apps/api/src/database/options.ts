import { Invitation, DispatcherApplication, ApplicantChallenge, ApplicationActivity, ApplicationReview, ApplicationSubmission } from '../modules/onboarding/entities';
import { User } from '../modules/users/user.entity';
import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import type { Environment } from '../config/environment';
export function databaseOptions(env: Environment): DataSourceOptions {
  return {
    type: 'postgres', uuidExtension: 'pgcrypto', installExtensions: false, url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    synchronize: false, migrationsRun: false, entities: [User, Invitation, DispatcherApplication, ApplicantChallenge, ApplicationActivity, ApplicationReview, ApplicationSubmission],
    migrations: [join(__dirname, 'migrations', '*{.ts,.js}')],
    extra: { connectionTimeoutMillis: 5000, statement_timeout: 4000, max: 10 },
  };
}
