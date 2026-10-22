import Joi from 'joi';
export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production'; PORT: number;
  DATABASE_URL: string; DATABASE_SSL: boolean; CORS_ORIGINS: string; SESSION_SECRET: string; BFF_SHARED_SECRET: string; WEB_ORIGIN: string; SESSION_TTL_SECONDS: number;
  DEPLOYMENT_PURPOSE: 'local' | 'production' | 'demo'; DEMO_EMAIL_MODE: boolean;
  DEMO_FICTIONAL_DATA_ONLY: boolean; DEMO_STARTER_MODE: boolean; DEMO_DEPLOYMENT_ID?: string; DEMO_MAILBOX_KEY?: string;
}
const schema = Joi.object({
  DEPLOYMENT_PURPOSE: Joi.string().valid('local', 'production', 'demo'),
  DEMO_EMAIL_MODE: Joi.boolean().default(false),
  DEMO_FICTIONAL_DATA_ONLY: Joi.boolean().default(false),
  DEMO_STARTER_MODE: Joi.boolean().default(false),
  DEMO_DEPLOYMENT_ID: Joi.string().guid({ version: 'uuidv4' }).empty(''),
  DEMO_MAILBOX_KEY: Joi.string().pattern(/^[A-Za-z0-9+/]{43}=$/).empty(''),
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
  const { value, error } = schema.validate(input, { abortEarly: false });
  if (error) throw new Error(`Invalid environment: ${error.details.map((detail) => `${detail.path.join('.')} (${detail.type})`).join('; ')}`);
  const env = value as Environment;
  env.DEPLOYMENT_PURPOSE ??= env.NODE_ENV === 'production' ? 'production' : 'local';
  if (env.SESSION_SECRET === env.BFF_SHARED_SECRET) throw new Error('Session and BFF secrets must differ');
  if (env.NODE_ENV === 'production' && !env.WEB_ORIGIN.startsWith('https://')) throw new Error('Production WEB_ORIGIN must use HTTPS');
  if (env.NODE_ENV === 'production' && env.DEPLOYMENT_PURPOSE === 'local') throw new Error('Hosted runtime must have an explicit production or demo purpose');
  if (env.DEMO_EMAIL_MODE || env.DEPLOYMENT_PURPOSE === 'demo') {
    const demoDatabase = decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1));
    const validName = /_demo(?:_test)?$/.test(demoDatabase);
    if (!env.DEMO_EMAIL_MODE || env.DEPLOYMENT_PURPOSE !== 'demo' || !env.DEMO_FICTIONAL_DATA_ONLY || !env.DEMO_DEPLOYMENT_ID
      || !env.DEMO_MAILBOX_KEY || Buffer.from(env.DEMO_MAILBOX_KEY, 'base64').length !== 32
      || (!env.DEMO_STARTER_MODE && (!validName || !/(^|[.-])demo([.-]|$)/.test(new URL(env.WEB_ORIGIN).hostname)))) {
      throw new Error('Demo email requires explicit demo configuration and either isolated naming or an explicitly converted starter database');
    }
    if (env.DEMO_MAILBOX_KEY === env.SESSION_SECRET || env.DEMO_MAILBOX_KEY === env.BFF_SHARED_SECRET) throw new Error('Demo mailbox key must be separate from session/BFF secrets');
  } else if (env.DEMO_STARTER_MODE || env.DEMO_FICTIONAL_DATA_ONLY || env.DEMO_DEPLOYMENT_ID || env.DEMO_MAILBOX_KEY) {
    throw new Error('Demo configuration is forbidden outside a designated demo deployment');
  }
  return env;
}
