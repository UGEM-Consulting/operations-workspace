// Transport/CSRF checks only. Business permissions remain in NestJS.
const ID = '[0-9a-f-]{36}', PHOTO = '(selfie|id-selfie)';
const match = (pattern: string, path: string) => new RegExp(`^${pattern}$`).test(path);
// Private files served as-is (JPEG photos and PDFs) instead of JSON.
const FILE_ROUTES = [`applicant/photos/${PHOTO}`, `applicant/documents/${ID}/(file|signed)`, `documents/${ID}/file`,
  `onboarding/applications/${ID}/photos/${PHOTO}`, `onboarding/applications/${ID}/documents/${ID}/signed`, `it/onboarding/${ID}/photo`,
  `dispatch/members/${ID}/photos/${PHOTO}`, `dispatch/members/${ID}/documents/${ID}/signed`, `driver/documents/${ID}/file`, `safety/drivers/${ID}/documents/${ID}/file`, `safety/drivers/${ID}/reports/${ID}/file`,
  `safety/consents/${ID}/file`, `safety/drivers/${ID}/consents/${ID}/signed`, `driver/consents/${ID}/(file|signed)`];
const SCAN = '(license|medical-card|work-authorization)';
export function allowedEndpoint(method: string, path: string): boolean {
  return (method === 'GET' && ['it/onboarding','notifications'].includes(path)) ||
    (method === 'GET' && /^it\/onboarding\/[0-9a-f-]{36}$/.test(path)) ||
    (method === 'PATCH' && /^it\/onboarding\/[0-9a-f-]{36}\/(contact|tasks\/[A-Z_]+)$/.test(path)) ||
    (method === 'POST' && /^notifications\/[0-9a-f-]{36}\/read$/.test(path)) ||
    (method === 'POST' && ['applicant/begin','applicant/verify','applicant/submit','applicant/logout','onboarding/invitations'].includes(path)) ||
    (method === 'PATCH' && ['applicant/draft','applicant/updates'].includes(path)) ||
    // Applicant status updates: chosen channels and the Telegram connect link.
    (method === 'GET' && path === 'applicant/updates') ||
    (method === 'POST' && ['applicant/updates/telegram','applicant/updates/telegram/check','applicant/updates/telegram/disconnect'].includes(path)) ||
    (method === 'GET' && ['applicant/application','onboarding/invitations','onboarding/applications','onboarding/review-queue','onboarding/summary'].includes(path)) ||
    (method === 'GET' && /^onboarding\/applications\/[0-9a-f-]{36}$/.test(path)) ||
    (method === 'POST' && /^onboarding\/applications\/[0-9a-f-]{36}\/reviews$/.test(path)) ||
    (method === 'POST' && /^onboarding\/invitations\/[0-9a-f-]{36}\/revoke$/.test(path)) ||
    (method === 'POST'  && ['auth/login', 'auth/logout', 'users'].includes(path)) ||
    // Own password: the forced change after an administrator-set password, or a change from Account security.
    (method === 'POST' && path === 'auth/password') ||
    (method === 'GET' && ['auth/me', 'users'].includes(path)) ||
    // Staff two-step verification: sign-in step, enrolment, own settings, administrator reset and policy.
    (method === 'POST' && ['auth/mfa/verify', 'auth/mfa/challenge', 'auth/mfa/enrolment', 'auth/mfa/enrolment/confirm', 'auth/mfa/email-code', 'auth/mfa/recovery-codes', 'auth/mfa/disable'].includes(path)) ||
    (method === 'GET' && ['auth/mfa', 'auth/mfa/methods', 'settings/security'].includes(path)) || (method === 'PATCH' && path === 'settings/security') ||
    (method === 'POST' && match(`users/${ID}/mfa/reset`, path)) ||
    (method === 'PATCH' && /^users\/[0-9a-f-]{36}$/.test(path)) ||
    // The approver's own saved countersigning signature.
    // Own Telegram connection for workspace alerts.
    (method === 'GET' && path === 'staff/telegram') || (method === 'POST' && ['staff/telegram/connect', 'staff/telegram/check', 'staff/telegram/disconnect'].includes(path)) ||
    (method === 'GET' && path === 'staff/signature') || (method === 'POST' && ['staff/signature', 'staff/signature/delete'].includes(path)) ||
    (method === 'GET' && path === 'documents') || (method === 'POST' && path === 'documents') ||
    // Managed lists: add, edit, archive and restore MCs and job titles.
    (method === 'POST' && ['lists/mcs', 'lists/job-titles'].includes(path)) || (method === 'PATCH' && match(`lists/(mcs|job-titles)/${ID}`, path)) ||
    // Teams and dispatch members: add and edit teams, move a dispatcher, mark them as left, change their job title.
    (method === 'POST' && (path === 'dispatch/teams' || match(`dispatch/members/${ID}/(move|leave|contacts|reassign)`, path) || match(`dispatch/members/${ID}/contacts/${ID}/remove`, path))) ||
    (method === 'PATCH' && match(`dispatch/(teams|members)/${ID}`, path)) ||
    // Promotions: a team lead's request or cancellation, and a manager's decision.
    (method === 'POST' && (path === 'team/promotions' || match(`team/promotions/${ID}/cancel`, path) || match(`dispatch/promotions/${ID}/decide`, path))) ||
    // Safety drivers: add and edit a driver, withdraw or reopen them, assign their safety staff owner.
    (method === 'POST' && (path === 'safety/drivers' || match(`safety/drivers/${ID}/(withdraw|reopen|owner|link|link/cancel|ssn)`, path))) ||
    // A driver filling in their application (driver session cookie; no staff account).
    (method === 'POST' && (['driver/begin', 'driver/verify', 'driver/application/submit', 'driver/logout'].includes(path) || match(`driver/documents/${SCAN}`, path))) ||
    (method === 'POST' && match(`safety/drivers/${ID}/documents/${ID}/verify`, path)) ||
    // Screening (checks, the MVR, corrections, the hand-off) and the Safety manager's decision.
    (method === 'POST' && match(`safety/drivers/${ID}/(checks/[A-Z_]+|mvr|corrections|send-for-decision|decision)`, path)) ||
    // Driver consent forms: the Safety manager publishes them; a driver opens and signs them in their application.
    (method === 'POST' && (path === 'safety/consents' || match(`driver/consents/${ID}/(view|sign)`, path))) ||
    ((method === 'GET' || method === 'PATCH') && path === 'driver/application') || (method === 'PATCH' && match(`safety/drivers/${ID}`, path)) ||
    (method === 'POST' && (match(`applicant/photos/${PHOTO}`, path) || match(`applicant/documents/${ID}/(view|sign)`, path))) ||
    (method === 'GET' && isFileEndpoint(path));
}
export function isFileEndpoint(path: string): boolean { return FILE_ROUTES.some(pattern => match(pattern, path)); }
/** Request body limits in bytes. Photo and PDF uploads stay under Vercel's 4.5 MB function payload limit. */
export function bodyLimit(path: string): number {
  if (path === 'documents' || match(`applicant/photos/${PHOTO}`, path) || match(`driver/documents/${SCAN}`, path) || match(`safety/drivers/${ID}/mvr`, path) || path === 'safety/consents') return 4_400_000;
  // Signature images (applicant signing, NDA countersignature during approval, a saved staff signature).
  if (match(`applicant/documents/${ID}/sign`, path) || match(`driver/consents/${ID}/sign`, path) || match(`onboarding/applications/${ID}/reviews`, path) || path === 'staff/signature') return 400_000;
  return 16384;
}
export function validMutation(headers: Headers, origins: string[]): boolean {
  return origins.includes(headers.get('origin') ?? '') && headers.get('x-csrf-protection') === '1' &&
    headers.get('content-type')?.split(';')[0].trim() === 'application/json' &&
    (!headers.get('sec-fetch-site') || headers.get('sec-fetch-site') === 'same-origin');
}
