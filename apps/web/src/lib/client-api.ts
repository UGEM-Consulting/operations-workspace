// Browser calls to the same-origin BFF. Every failure becomes an ApiError with a user-facing message:
// raw TypeError/SyntaxError text ("Failed to fetch", "Unexpected token") never reaches the page.
// Mutations are never retried automatically.

/** network: the request never completed; session/applicant-session: sign in or verify again; unavailable: cold start or outage. */
export type ApiErrorKind = 'network' | 'session' | 'applicant-session' | 'conflict' | 'too-large' | 'unavailable' | 'request';

// Plain fields (no parameter properties) so the module also runs under Node's type stripping in tests.
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  constructor(message: string, kind: ApiErrorKind, status?: number) { super(message); this.name = 'ApiError'; this.kind = kind; this.status = status; }
}

export const apiMessages = {
  network: 'Connection lost. Your entries are kept. Try again.',
  tooLarge: 'This file is too large.',
  // Same wording as the BFF timeout: a sleeping API can take up to a minute to start.
  unavailable: 'The service is taking too long to respond. It may be starting up. Please wait a minute and try again.',
  session: 'Your session ended. Sign in again.',
  applicantSession: 'Your session expired. Verify your email again to continue.',
  driverSession: 'Your session expired. Open the link from Safety again and verify your email.',
  generic: 'Something went wrong. Please try again.',
} as const;

/** Fired on window when a 401 means the session is gone, so the shell or applicant form can offer sign-in or re-verification. */
export const SESSION_ENDED_EVENT = 'workspace:session-ended';
export const APPLICANT_SESSION_EXPIRED_EVENT = 'applicant:session-expired';

// On these endpoints 401 means a wrong password or code, not an ended session; their own message is shown.
const credentialPaths = new Set(['auth/login', 'auth/password', 'auth/mfa/verify', 'auth/mfa/enrolment', 'auth/mfa/enrolment/confirm', 'auth/mfa/recovery-codes', 'auth/mfa/disable', 'auth/logout', 'applicant/begin', 'applicant/verify', 'applicant/logout', 'driver/begin', 'driver/verify', 'driver/logout']);
// API messages for a lost applicant session; other applicant 401 messages (access window closed, application withdrawn) are final.
const applicantSessionMessages = new Set(['Please verify your access again.', 'Unauthorized']);

function serverMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || !('message' in data)) return undefined;
  const { message } = data as { message: unknown };
  if (Array.isArray(message) && message.every(item => typeof item === 'string')) return message.join('. ');
  return typeof message === 'string' && message.trim() ? message : undefined;
}

async function readJson(response: Response): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    const text = await response.text();
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch { return { ok: false }; }
}

function notify(event: string) {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(event));
}

/** Maps a failed response to an ApiError. Exported for tests and for readers of non-JSON file endpoints. */
export function responseError(path: string, status: number, data: unknown, json: boolean): ApiError {
  const message = json ? serverMessage(data) : undefined;
  if (status === 413) return new ApiError(apiMessages.tooLarge, 'too-large', status);
  if (status === 502 || status === 504 || (status === 503 && !message)) return new ApiError(apiMessages.unavailable, 'unavailable', status);
  if (status === 401 && credentialPaths.has(path)) {
    const known = message && message !== 'Unauthorized' ? message : undefined;
    return new ApiError(known ?? (path.startsWith('applicant/') ? apiMessages.applicantSession : apiMessages.session), 'request', status);
  }
  if (status === 401 && path.startsWith('driver/')) {
    // A driver has no staff session to end: their link or session closed. A final message (link cancelled) is shown as is.
    return new ApiError(message && message !== 'Unauthorized' ? message : apiMessages.driverSession, 'applicant-session', status);
  }
  if (status === 401) {
    if (path.startsWith('applicant/')) {
      if (!message || applicantSessionMessages.has(message)) { notify(APPLICANT_SESSION_EXPIRED_EVENT); return new ApiError(apiMessages.applicantSession, 'applicant-session', status); }
      return new ApiError(message, 'request', status);
    }
    notify(SESSION_ENDED_EVENT);
    return new ApiError(apiMessages.session, 'session', status);
  }
  if (status === 409) return new ApiError(message ?? 'This record changed. Reload and try again.', 'conflict', status);
  if (status === 503) return new ApiError(message ?? apiMessages.unavailable, 'unavailable', status);
  return new ApiError(message ?? apiMessages.generic, 'request', status);
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/backend/${path}`, init); }
  catch { throw new ApiError(apiMessages.network, 'network'); }
  if (response.status === 204) return null as T;
  const body = await readJson(response);
  if (!response.ok) throw responseError(path, response.status, body.ok ? body.data : undefined, body.ok);
  // A success page that is not JSON came from a gateway, not the API.
  if (!body.ok) throw new ApiError(apiMessages.unavailable, 'unavailable', response.status);
  return body.data as T;
}

/** Response shapes of sign-in endpoints whose callers read the result without naming a type. */
export interface KnownResponses {
  'auth/login': { mfa?: string; landingPage: string };
  'auth/mfa/verify': { landingPage: string; recoveryCodesRemaining?: number };
  'auth/mfa/enrolment/confirm': { recoveryCodes: string[]; landingPage: string };
  'auth/mfa/recovery-codes': { recoveryCodes: string[] };
}
type Result<T, P extends string> = [T] extends [never] ? P extends keyof KnownResponses ? KnownResponses[P] : unknown : T;

/** A JSON mutation through the BFF with the CSRF header. Never retried automatically. Name the result type: mutate<Record>(…). */
export function mutate<T = never, P extends string = string>(path: P, method: 'POST' | 'PATCH', body: unknown = {}): Promise<Result<T, P>> {
  return request<Result<T, P>>(path, { method, headers: { 'content-type': 'application/json', 'x-csrf-protection': '1' }, body: JSON.stringify(body) });
}

/** A JSON read through the BFF. */
export function readApi<T = unknown>(path: string): Promise<T> {
  return request<T>(path, { cache: 'no-store' });
}

/** The user-facing text of any thrown value; never a raw exception message from outside this module. */
export function errorMessage(error: unknown, fallback: string = apiMessages.generic): string {
  return error instanceof ApiError ? error.message : fallback;
}
