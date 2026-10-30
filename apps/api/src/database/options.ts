import { ItOnboardingRequest, ItOnboardingTask, ItOnboardingActivity, PortalNotification } from '../modules/it/it.entity';
import { Invitation, DispatcherApplication, ApplicantChallenge, ApplicationActivity, ApplicationReview, ApplicationSubmission } from '../modules/onboarding/entities';
import { User } from '../modules/users/user.entity';
import { StaffMfa, StaffRecoveryCode, StaffSecurityEvent, StaffSecuritySettings } from '../modules/auth/mfa.entity';
import { ApplicantPhoto, CompanyDocument, DocumentSignature, DocumentView, StaffSavedSignature } from '../modules/documents/documents.entity';
import { ApplicantUpdateDelivery, ApplicantUpdateSettings, TelegramLinkToken, TelegramPollState, StaffTelegramLink, StaffTelegramLinkToken, NotificationDelivery } from '../modules/updates/updates.entity';
import { JobTitle, ListEvent, Mc } from '../modules/lists/lists.entity';
import { DispatchEvent, DispatchMember, MemberAssignment, MemberContact, MemberSupportLink, PromotionRequest, Team } from '../modules/dispatch/dispatch.entity';
import { Driver, DriverApplication, DriverChallenge, DriverEvent, DriverLink, DriverOwner } from '../modules/safety/safety.entity';
import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import type { Environment } from '../config/environment';
export function databaseOptions(env: Environment): DataSourceOptions {
  return {
    type: 'postgres', uuidExtension: 'pgcrypto', installExtensions: false, url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    synchronize: false, migrationsRun: false, entities: [User, Invitation, DispatcherApplication, ApplicantChallenge, ApplicationActivity, ApplicationReview, ApplicationSubmission, ItOnboardingRequest, ItOnboardingTask, ItOnboardingActivity, PortalNotification, CompanyDocument, ApplicantPhoto, DocumentSignature, DocumentView, StaffSavedSignature, StaffMfa, StaffRecoveryCode, StaffSecurityEvent, StaffSecuritySettings, ApplicantUpdateSettings, TelegramLinkToken, ApplicantUpdateDelivery, TelegramPollState, StaffTelegramLink, StaffTelegramLinkToken, NotificationDelivery, Mc, JobTitle, ListEvent, DispatchMember, Team, MemberAssignment, DispatchEvent, MemberContact, MemberSupportLink, PromotionRequest, Driver, DriverOwner, DriverEvent, DriverLink, DriverChallenge, DriverApplication],
    migrations: [join(__dirname, 'migrations', '*{.ts,.js}')],
    extra: { connectionTimeoutMillis: 5000, statement_timeout: 4000, max: 10 },
  };
}
