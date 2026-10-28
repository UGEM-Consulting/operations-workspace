import { EnvironmentError } from './config/environment';
// Network/TLS failures reaching PostgreSQL. Codes only; messages can contain hostnames or credentials.
const SAFE_CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
/** A deploy-log-safe reason: setting rules, error codes and fixed migration guard texts, never values or data. */
export function startupFailureReason(error: unknown): string {
  if (error instanceof EnvironmentError) return `configuration: ${error.message}`;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  // Migration guards RAISE fixed, data-free texts (SQLSTATE P0001); other database messages are never printed.
  if (code === 'P0001' && error instanceof Error) return `migration refused: ${error.message.split('\n')[0].slice(0, 200)}`;
  if (/^[0-9A-Z]{5}$/.test(code)) return `database error SQLSTATE ${code}`;
  if (SAFE_CONNECTION_CODES.has(code)) return `database connection failed: ${code}`;
  return 'unexpected error (details suppressed)';
}
