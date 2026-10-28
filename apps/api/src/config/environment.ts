import Joi from 'joi';
export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production'; PORT: number;
  DATABASE_URL: string; DATABASE_SSL: boolean; CORS_ORIGINS: string; SESSION_SECRET: string; BFF_SHARED_SECRET: string; WEB_ORIGIN: string; SESSION_TTL_SECONDS: number;
  DEPLOYMENT_PURPOSE: 'local' | 'staging' | 'production';
  EMAIL_DELIVERY: 'none' | 'smtp'; SMTP_HOST?: string; SMTP_PORT: number; SMTP_USER?: string; SMTP_PASSWORD?: string; EMAIL_FROM?: string;
  STORAGE_DRIVER: 'none' | 'local' | 'gcs'; STORAGE_LOCAL_DIR?: string; GCS_BUCKET?: string; GCS_CREDENTIALS_BASE64?: string;
  MFA_ENCRYPTION_KEY?: string;
}
/** Decodes the base64 service-account key; null when it is not a usable service-account JSON. Never logs it. */
export function serviceAccountCredentials(encoded: string): { client_email: string; private_key: string; project_id?: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const key = parsed as Record<string, unknown>;
    return key.type === 'service_account' && typeof key.client_email === 'string' && typeof key.private_key === 'string'
      ? { client_email: key.client_email, private_key: key.private_key, ...(typeof key.project_id === 'string' ? { project_id: key.project_id } : {}) } : null;
  } catch { return null; }
}
// Messages name settings and rules only, never values, so operators can safely see them in deploy logs.
export class EnvironmentError extends Error {}
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
// Settings of the retired fictional demo deployment. Their presence means a service still configured for it.
const RETIRED_DEMO_SETTINGS = ['DEMO_EMAIL_MODE', 'DEMO_STARTER_MODE', 'DEMO_FICTIONAL_DATA_ONLY', 'DEMO_DEPLOYMENT_ID', 'DEMO_MAILBOX_KEY'];
// One address, optionally with a display name: "Name <a@b>" or "a@b". No line breaks, lists or nested addresses.
const SENDER = /^(?:[^<>@\r\n,;"]*<[^<>@\s,;"]+@[^<>@\s,;"]+>|[^<>@\s,;"]+@[^<>@\s,;"]+)$/;
// URL accepts wildcard hosts such as https://*.example.test; origins must name a literal host or IP address.
const LITERAL_HOST = /^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/;
// Comma-separated exact HTTP(S) origins (no path, wildcard or trailing slash), normalized without spaces.
const originList = (value: string, helpers: Joi.CustomHelpers) => {
  try {
    const origins = value.split(',').map((origin) => origin.trim());
    if (origins.length > 10 || new Set(origins).size !== origins.length || origins.some((origin) => {
      const url = new URL(origin);
      return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin || !LITERAL_HOST.test(url.hostname);
    })) return helpers.error('any.invalid');
    return origins.join(',');
  } catch { return helpers.error('any.invalid'); }
};
/** Browser origins allowed to send credentialed mutations. The first is the primary origin used in emailed links. */
export const webOrigins = (env: Pick<Environment, 'WEB_ORIGIN'>) => env.WEB_ORIGIN.split(',');
const schema = Joi.object({
  EMAIL_DELIVERY: Joi.string().valid('none', 'smtp').default('none'),
  SMTP_HOST: Joi.string().hostname().empty(''),
  SMTP_PORT: Joi.number().port().default(465),
  SMTP_USER: Joi.string().max(254).empty(''),
  SMTP_PASSWORD: Joi.string().max(256).empty(''),
  EMAIL_FROM: Joi.string().trim().max(320).pattern(SENDER).empty(''),
  STORAGE_DRIVER: Joi.string().valid('none', 'local', 'gcs').default('none'),
  STORAGE_LOCAL_DIR: Joi.string().max(500).empty(''),
  // Bucket naming rules: 3–63 lowercase letters, digits, dashes, underscores or dots.
  GCS_BUCKET: Joi.string().pattern(/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/).empty(''),
  GCS_CREDENTIALS_BASE64: Joi.string().base64().max(20000).empty(''),
  // 32 random bytes, base64. Encrypts staff TOTP secrets at rest; MfaService requires it in production.
  MFA_ENCRYPTION_KEY: Joi.string().base64().empty(''),
  DEPLOYMENT_PURPOSE: Joi.string().valid('local', 'staging', 'production'),
  SESSION_SECRET: Joi.string().min(32).required(),
  BFF_SHARED_SECRET: Joi.string().min(32).required(),
  SESSION_TTL_SECONDS: Joi.number().integer().min(60).max(86400).default(28800),
  WEB_ORIGIN: Joi.string().required().custom(originList),
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(4000),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).required(),
  DATABASE_SSL: Joi.boolean().default(false),
  CORS_ORIGINS: Joi.string().required().custom(originList),
}).unknown(true);
export function validateEnvironment(input: Record<string, unknown>): Environment {
  if (input.DEPLOYMENT_PURPOSE === 'demo' || RETIRED_DEMO_SETTINGS.some(key => ![undefined, null, '', false, 'false'].includes(input[key] as string))) {
    throw new EnvironmentError(`The fictional demo deployment was retired. Remove DEPLOYMENT_PURPOSE=demo and ${RETIRED_DEMO_SETTINGS.join('/')} and use a fresh production database.`);
  }
  const { value, error } = schema.validate(input, { abortEarly: false });
  if (error) throw new EnvironmentError(`Invalid environment: ${error.details.map((detail) => `${detail.path.join('.')} (${detail.type})`).join('; ')}`);
  const env = value as Environment;
  env.DEPLOYMENT_PURPOSE ??= env.NODE_ENV === 'production' ? 'production' : 'local';
  if (env.SESSION_SECRET === env.BFF_SHARED_SECRET) throw new EnvironmentError('Session and BFF secrets must differ');
  if (env.NODE_ENV === 'production' && webOrigins(env).some(origin => !origin.startsWith('https://'))) throw new EnvironmentError('Production WEB_ORIGIN values must all use HTTPS');
  if (env.NODE_ENV === 'production' && env.DEPLOYMENT_PURPOSE === 'local') throw new EnvironmentError('Hosted runtime must have an explicit production or staging purpose');
  // Staging is a hosted copy for staff testing: production rules (HTTPS, real TLS email) with its own database and secrets.
  if (env.DEPLOYMENT_PURPOSE === 'staging' && env.NODE_ENV !== 'production') throw new EnvironmentError('DEPLOYMENT_PURPOSE=staging is hosted and requires NODE_ENV=production');
  if (env.EMAIL_DELIVERY === 'smtp') {
    if (!env.SMTP_HOST || !env.EMAIL_FROM) throw new EnvironmentError('SMTP delivery requires SMTP_HOST and a valid EMAIL_FROM');
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) throw new EnvironmentError('SMTP_USER and SMTP_PASSWORD must be set together');
    if (env.NODE_ENV !== 'production') {
      // Development and tests use fictional data only: never a real mail server, only a local inbox such as Mailpit.
      if (!LOCAL_HOSTS.includes(env.SMTP_HOST)) throw new EnvironmentError('Outside production, SMTP may only target a local test inbox on localhost');
    } else if (!env.SMTP_USER || ![465, 587].includes(env.SMTP_PORT)) {
      throw new EnvironmentError('Production SMTP requires authentication on TLS port 465 or 587');
    }
  }
  // Applicant photos and signed documents: a private Google Cloud Storage bucket in production, a local
  // folder for fictional development data. The API server (StorageService) refuses production without gcs;
  // operator CLIs that never touch files share this validation and do not need storage settings.
  if (env.NODE_ENV === 'production' ? env.STORAGE_DRIVER === 'local' : env.STORAGE_DRIVER === 'gcs') {
    throw new EnvironmentError(env.NODE_ENV === 'production' ? 'Production storage must use STORAGE_DRIVER=gcs' : 'Outside production, STORAGE_DRIVER may only be local or none');
  }
  if (env.STORAGE_DRIVER === 'gcs' && (!env.GCS_BUCKET || !env.GCS_CREDENTIALS_BASE64 || !serviceAccountCredentials(env.GCS_CREDENTIALS_BASE64))) {
    throw new EnvironmentError('STORAGE_DRIVER=gcs requires GCS_BUCKET and GCS_CREDENTIALS_BASE64 (a base64-encoded service-account JSON key)');
  }
  if (env.MFA_ENCRYPTION_KEY && Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64').length !== 32) throw new EnvironmentError('MFA_ENCRYPTION_KEY must be 32 random bytes encoded as base64');
  if (env.MFA_ENCRYPTION_KEY && [env.SESSION_SECRET, env.BFF_SHARED_SECRET].includes(env.MFA_ENCRYPTION_KEY)) throw new EnvironmentError('MFA_ENCRYPTION_KEY must differ from the session and BFF secrets');
  if (env.STORAGE_DRIVER === 'local' && !env.STORAGE_LOCAL_DIR) throw new EnvironmentError('STORAGE_DRIVER=local requires STORAGE_LOCAL_DIR');
  return env;
}
