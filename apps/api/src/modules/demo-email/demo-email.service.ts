import { digest } from '../onboarding/verification-code';
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { Environment, validateEnvironment } from '../../config/environment';
import { ApplicantChallenge, ApplicationActivity, Invitation, DispatcherApplication } from '../onboarding/entities';
import { onboardingLimit } from '../onboarding/rate-limit';
import { Role, User, UserStatus } from '../users/user.entity';
import { assertDemoIdentity } from './isolation';
import { DemoMailboxMessage } from './mailbox.entity';

@Injectable()
export class DemoEmailService implements OnModuleInit {
  private readonly env: Environment | null;
  constructor(private readonly db: DataSource, private readonly config: ConfigService) {
    this.env = config.get('DEMO_EMAIL_MODE') === true ? validateEnvironment(Object.fromEntries([
      'NODE_ENV','DATABASE_URL','DATABASE_SSL','WEB_ORIGIN','CORS_ORIGINS','SESSION_SECRET','BFF_SHARED_SECRET',
      'DEPLOYMENT_PURPOSE','DEMO_EMAIL_MODE','DEMO_STARTER_MODE','DEMO_FICTIONAL_DATA_ONLY','DEMO_DEPLOYMENT_ID','DEMO_MAILBOX_KEY',
    ].map(key => [key, config.get(key)]))) : null;
  }
  get enabled() { return this.env !== null; }
  async onModuleInit() {
    if (this.env) {
      try { await assertDemoIdentity(this.db.manager, this.env); }
      catch { throw new Error('Demo email startup refused: database identity, fictional data or administrator checks failed.'); }
    }
  }
  async assertAvailable() {
    if (this.env) {
      try { await assertDemoIdentity(this.db.manager, this.env); }
      catch { throw new ServiceUnavailableException('Demo verification is unavailable: deployment isolation check failed.'); }
    } else if (this.config.get('NODE_ENV') === 'production' || this.config.get('DEPLOYMENT_PURPOSE') === 'production') {
      throw new ServiceUnavailableException('Email verification delivery is not configured.');
    }
  }
  // Called in the challenge transaction. Local development keeps private CLI delivery.
  async deliver(em: EntityManager, challenge: ApplicantChallenge) {
    if (!this.env || !challenge.invitationId || !challenge.email) return;
    if (!challenge.email.endsWith('@example.test')) throw new ForbiddenException();
    await assertDemoIdentity(em, this.env);
    const code = randomInt(0, 100000000).toString().padStart(8, '0');
    challenge.codeHash = digest(code);
    await em.getRepository(ApplicantChallenge).save(challenge);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(this.env.DEMO_MAILBOX_KEY!, 'base64'), nonce);
    cipher.setAAD(Buffer.from(challenge.id));
    const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    const ciphertext = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
    await em.getRepository(DemoMailboxMessage).save({ challengeId: challenge.id, ciphertext });
    await em.getRepository(ApplicationActivity).save({ invitationId: challenge.invitationId, actorId: null, event: 'DEMO_VERIFICATION_DELIVERED' });
  }
  async consumed(em: EntityManager, challengeId: string) {
    // Also safely handles non-demo challenges; no verification/session semantics change.
    await em.getRepository(DemoMailboxMessage).delete({ challengeId });
  }
  private async administrator(user: User) {
    if (!this.env) throw new NotFoundException();
    if (user.role !== Role.SYSTEM_ADMIN || user.status !== UserStatus.ACTIVE) throw new ForbiddenException();
    await this.assertAvailable();
  }
  async mailbox(user: User) {
    await this.administrator(user);
    await onboardingLimit(this.db, 'demo-mailbox-list:' + user.id, 60, 60);
    return this.db.query(`SELECT m.id, m."challengeId", c.email, c."expiresAt", m."createdAt" FROM demo_mailbox m
      JOIN applicant_challenges c ON c.id=m."challengeId" JOIN invitations i ON i.id=c."invitationId"
      WHERE c."consumedAt" IS NULL AND c."expiresAt">now() AND i."revokedAt" IS NULL
      ORDER BY m."createdAt" DESC LIMIT 50`);
  }
  async reveal(user: User, id: string) {
    await this.administrator(user);
    await onboardingLimit(this.db, 'demo-mailbox-reveal:' + user.id, 30, 60);
    return this.db.transaction(async em => {
      const message = await em.getRepository(DemoMailboxMessage).createQueryBuilder('m').addSelect('m.ciphertext').where('m.id=:id', { id }).getOne();
      if (!message) throw new NotFoundException();
      // Match verify() lock order. Consumed/expired/revoked challenges cannot be revealed.
      const challenge = await em.getRepository(ApplicantChallenge).findOne({ where: { id: message.challengeId }, lock: { mode: 'pessimistic_write' } });
      const inv = challenge?.invitationId ? await em.getRepository(Invitation).findOne({ where: { id: challenge.invitationId }, lock: { mode: 'pessimistic_write' } }) : null;
      const app = inv ? await em.getRepository(DispatcherApplication).findOneBy({ invitationId: inv.id }) : null;
      if (!challenge?.email?.endsWith('@example.test') || challenge.consumedAt || challenge.expiresAt.getTime() <= Date.now() || !inv || !app || inv.revokedAt
        || (inv.expectedEmail && inv.expectedEmail !== challenge.email)
        || (challenge.resume ? inv.email !== challenge.email || app.applicantAccessUntil.getTime() <= Date.now() : inv.consumedAt || inv.expiresAt.getTime() <= Date.now())) throw new NotFoundException();
      const raw = Buffer.from(message.ciphertext, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.env!.DEMO_MAILBOX_KEY!, 'base64'), raw.subarray(0,12));
      decipher.setAuthTag(raw.subarray(12,28)); decipher.setAAD(Buffer.from(challenge.id));
      const code = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      await em.getRepository(ApplicationActivity).save({ invitationId: inv.id, actorId: user.id, event: 'DEMO_VERIFICATION_VIEWED' });
      return { code, expiresAt: challenge.expiresAt };
    });
  }
}
