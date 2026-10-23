import Joi from 'joi';
export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production'; PORT: number;
  DATABASE_URL: string; DATABASE_SSL: boolean; CORS_ORIGINS: string; SESSION_SECRET: string; BFF_SHARED_SECRET: string; WEB_ORIGIN: string; SESSION_TTL_SECONDS: number;
  DEPLOYMENT_PURPOSE: 'local' | 'production';
  EMAIL_DELIVERY: 'none' | 'smtp'; SMTP_HOST?: string; SMTP_PORT: number; SMTP_USER?: string; SMTP_PASSWORD?: string; EMAIL_FROM?: string;
}
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
// Settings of the retired fictional demo deployment. Their presence means a service still configured for it.
const RETIRED_DEMO_SETTINGS = ['DEMO_EMAIL_MODE', 'DEMO_STARTER_MODE', 'DEMO_FICTIONAL_DATA_ONLY', 'DEMO_DEPLOYMENT_ID', 'DEMO_MAILBOX_KEY'];
// One address, optionally with a display name: "Name <a@b>" or "a@b". No line breaks, lists or nested addresses.
const SENDER = /^(?:[^<>@\r\n,;"]*<[^<>@\s,;"]+@[^<>@\s,;"]+>|[^<>@\s,;"]+@[^<>@\s,;"]+)$/;
const schema = Joi.object({
  EMAIL_DELIVERY: Joi.string().valid('none', 'smtp').default('none'),
  SMTP_HOST: Joi.string().hostname().empty(''),
  SMTP_PORT: Joi.number().port().default(465),
  SMTP_USER: Joi.string().max(254).empty(''),
  SMTP_PASSWORD: Joi.string().max(256).empty(''),
  EMAIL_FROM: Joi.string().trim().max(320).pattern(SENDER).empty(''),
  DEPLOYMENT_PURPOSE: Joi.string().valid('local', 'production'),
  SESSION_SECRET: Joi.string().min(32).required(),
  BFF_SHARED_SECRET: Joi.string().min(32).required(),
  SESSION_TTL_SECONDS: Joi.number().integer().min(60).max(86400).default(28800),
  WEB_ORIGIN: Joi.string().uri({ scheme: ['http', 'https'] }).required().custom((value: string, helpers) => {
    const url = new URL(value);
    return url.origin === value ? value : helpers.error('any.invalid');
  }),
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(4000),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).required(),
  DATABASE_SSL: Joi.boolean().default(false),
  CORS_ORIGINS: Joi.string().required().custom((value: string, helpers) => {
    try {
      const origins = value.split(',').map((origin) => origin.trim());
      if (origins.some((origin) => {
        const url = new URL(origin);
        return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin;
      })) return helpers.error('any.invalid');
      return origins.join(',');
    } catch { return helpers.error('any.invalid'); }
  }),
}).unknown(true);
export function validateEnvironment(input: Record<string, unknown>): Environment {
  if (input.DEPLOYMENT_PURPOSE === 'demo' || RETIRED_DEMO_SETTINGS.some(key => ![undefined, null, '', false, 'false'].includes(input[key] as string))) {
    throw new Error(`The fictional demo deployment was retired. Remove DEPLOYMENT_PURPOSE=demo and ${RETIRED_DEMO_SETTINGS.join('/')} and use a fresh production database.`);
  }
  const { value, error } = schema.validate(input, { abortEarly: false });
  if (error) throw new Error(`Invalid environment: ${error.details.map((detail) => `${detail.path.join('.')} (${detail.type})`).join('; ')}`);
  const env = value as Environment;
  env.DEPLOYMENT_PURPOSE ??= env.NODE_ENV === 'production' ? 'production' : 'local';
  if (env.SESSION_SECRET === env.BFF_SHARED_SECRET) throw new Error('Session and BFF secrets must differ');
  if (env.NODE_ENV === 'production' && !env.WEB_ORIGIN.startsWith('https://')) throw new Error('Production WEB_ORIGIN must use HTTPS');
  if (env.NODE_ENV === 'production' && env.DEPLOYMENT_PURPOSE === 'local') throw new Error('Hosted runtime must have an explicit production purpose');
  if (env.EMAIL_DELIVERY === 'smtp') {
    if (!env.SMTP_HOST || !env.EMAIL_FROM) throw new Error('SMTP delivery requires SMTP_HOST and a valid EMAIL_FROM');
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) throw new Error('SMTP_USER and SMTP_PASSWORD must be set together');
    if (env.NODE_ENV !== 'production') {
      // Development and tests use fictional data only: never a real mail server, only a local inbox such as Mailpit.
      if (!LOCAL_HOSTS.includes(env.SMTP_HOST)) throw new Error('Outside production, SMTP may only target a local test inbox on localhost');
    } else if (!env.SMTP_USER || ![465, 587].includes(env.SMTP_PORT)) {
      throw new Error('Production SMTP requires authentication on TLS port 465 or 587');
    }
  }
  return env;
}
