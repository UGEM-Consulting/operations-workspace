import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { verificationEmail } from './verification-email';

// Only these Nodemailer error codes are logged; raw messages can contain addresses or server replies.
const SAFE_FAILURE_CODES = new Set(['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'EDNS', 'ESOCKET', 'ETLS', 'EENVELOPE', 'EMESSAGE', 'EPROTOCOL']);
// Credential, address and content problems will not succeed on a retry.
const PERMANENT_FAILURE_CODES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE']);
const RETRY_DELAYS_MS = [1000, 4000];
const SHUTDOWN_DRAIN_MS = 15000;
export function deliveryFailureCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  return SAFE_FAILURE_CODES.has(code) ? code : 'SEND_FAILED';
}

/** Applicant email delivery over SMTP (Google Workspace in production, Mailpit locally). Disabled unless EMAIL_DELIVERY=smtp. */
@Injectable()
export class EmailService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Email');
  private readonly transport: Transporter | null;
  private readonly from: string | undefined;
  private readonly pending = new Set<Promise<void>>();
  constructor(config: ConfigService) {
    this.from = config.get<string>('EMAIL_FROM');
    if (config.get('EMAIL_DELIVERY') !== 'smtp') { this.transport = null; return; }
    // validateEnvironment requires authenticated TLS (465/587) in production and a localhost inbox elsewhere.
    const port = Number(config.get('SMTP_PORT') ?? 465), user = config.get<string>('SMTP_USER');
    this.transport = createTransport({
      host: config.get<string>('SMTP_HOST'), port, secure: port === 465, requireTLS: port === 587,
      auth: user ? { user, pass: config.get<string>('SMTP_PASSWORD') } : undefined,
      tls: { minVersion: 'TLSv1.2' }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      disableFileAccess: true, disableUrlAccess: true,
    });
  }
  get enabled() { return this.transport !== null; }
  onModuleInit() {
    // Report misconfiguration early without blocking startup or logging server responses.
    if (this.transport) void this.transport.verify()
      .then(() => this.logger.log('SMTP connection verified'))
      .catch((error: unknown) => this.logger.warn(`SMTP connection check failed: ${deliveryFailureCode(error)}`));
  }
  async onApplicationShutdown() {
    // Let in-flight deliveries and their outcome records finish before a restart, within a bound.
    if (this.pending.size) await Promise.race([Promise.allSettled([...this.pending]), new Promise(resolve => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref())]);
  }
  /** Sends one verification code, retrying transient failures. Never throws; returns whether it was accepted. */
  async sendVerificationCode(to: string, code: string): Promise<boolean> {
    if (!this.transport) return false;
    const message = { from: this.from, to, ...verificationEmail(code) };
    for (let attempt = 0; ; attempt++) {
      try { await this.transport.sendMail(message); return true; }
      catch (error) {
        const failure = deliveryFailureCode(error);
        if (PERMANENT_FAILURE_CODES.has(failure) || attempt >= RETRY_DELAYS_MS.length) {
          this.logger.error(`Verification email delivery failed: ${failure}`);
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  /** Runs work after the HTTP response (equal response timing for matched and unmatched requests), tracked for shutdown. */
  runInBackground(task: () => Promise<void>): void {
    // setImmediate defers even the first query/connection until the current request has been answered.
    const run: Promise<void> = new Promise<void>(resolve => setImmediate(resolve)).then(task)
      .catch(() => this.logger.error('Background applicant verification task failed'))
      .finally(() => this.pending.delete(run));
    this.pending.add(run);
  }
}
