import Joi from 'joi';
export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production'; PORT: number;
  DATABASE_URL: string; DATABASE_SSL: boolean; CORS_ORIGINS: string; SESSION_SECRET: string; BFF_SHARED_SECRET: string; WEB_ORIGIN: string; SESSION_TTL_SECONDS: number;
}
const schema = Joi.object({
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
  if (error) throw new Error(`Invalid environment: ${error.details.map((detail) => detail.message).join('; ')}`);
  const env = value as Environment;
  if (env.SESSION_SECRET === env.BFF_SHARED_SECRET) throw new Error('Session and BFF secrets must differ');
  if (env.NODE_ENV === 'production' && !env.WEB_ORIGIN.startsWith('https://')) throw new Error('Production WEB_ORIGIN must use HTTPS');
  return env;
}
