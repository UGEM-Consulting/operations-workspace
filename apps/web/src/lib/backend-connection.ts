// No environment values or raw exception messages may enter diagnostic output.
export class BackendConfigurationError extends Error {
  constructor(readonly code: string) { super('Backend configuration is invalid'); }
}

export function readBackendConfig(env: Record<string, string | undefined>) {
  for (const name of ['API_BASE_URL', 'BFF_SHARED_SECRET', 'WEB_ORIGIN']) {
    if (!env[name]?.trim()) throw new BackendConfigurationError(`${name}_MISSING`);
  }
  function origin(name: 'API_BASE_URL' | 'WEB_ORIGIN', value: string) {
    try {
      const url = new URL(value.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        // URL accepts wildcard hosts such as https://*.example.test; require a literal host or IP address.
        || url.pathname !== '/' || !/^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/.test(url.hostname) || (env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error();
      return url.origin;
    } catch { throw new BackendConfigurationError(`${name}_INVALID`); }
  }
  const key = env.BFF_SHARED_SECRET!;
  if (key.length < 32 || key !== key.trim() || [...key].some(character => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126)) {
    throw new BackendConfigurationError('BFF_SHARED_SECRET_INVALID');
  }
  // WEB_ORIGIN may list several comma-separated origins (for example the Vercel and company domains); the first is primary.
  const origins = env.WEB_ORIGIN!.split(',').map(value => origin('WEB_ORIGIN', value));
  if (origins.length > 10 || new Set(origins).size !== origins.length) throw new BackendConfigurationError('WEB_ORIGIN_INVALID');
  return { base: origin('API_BASE_URL', env.API_BASE_URL!), key, origin: origins[0], origins };
}

export function backendFailureCode(error: unknown): string {
  if (error instanceof BackendConfigurationError) return error.code;
  if (error && typeof error === 'object') {
    // DOMException and cross-realm fetch errors need not be instanceof Error.
    const failure = error as { name?: unknown; cause?: { code?: unknown } };
    if (failure.name === 'TimeoutError' || failure.name === 'AbortError') return 'BACKEND_TIMEOUT';
    const cause = failure.cause;
    if (cause && typeof cause.code === 'string' && ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(cause.code)) return cause.code;
  }
  return 'BACKEND_REQUEST_FAILED';
}
