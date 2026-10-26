// Transport/CSRF checks only. Business permissions remain in NestJS.
const ID = '[0-9a-f-]{36}', PHOTO = '(selfie|id-selfie)';
const match = (pattern: string, path: string) => new RegExp(`^${pattern}$`).test(path);
// Private files served as-is (JPEG photos and PDFs) instead of JSON.
const FILE_ROUTES = [`applicant/photos/${PHOTO}`, `applicant/documents/${ID}/(file|signed)`, `documents/${ID}/file`,
  `onboarding/applications/${ID}/photos/${PHOTO}`, `onboarding/applications/${ID}/documents/${ID}/signed`, `it/onboarding/${ID}/photo`];
export function allowedEndpoint(method: string, path: string): boolean {
  return (method === 'GET' && ['it/onboarding','notifications'].includes(path)) ||
    (method === 'GET' && /^it\/onboarding\/[0-9a-f-]{36}$/.test(path)) ||
    (method === 'PATCH' && /^it\/onboarding\/[0-9a-f-]{36}\/(contact|tasks\/[A-Z_]+)$/.test(path)) ||
    (method === 'POST' && /^notifications\/[0-9a-f-]{36}\/read$/.test(path)) ||
    (method === 'POST' && ['applicant/begin','applicant/verify','applicant/submit','applicant/logout','onboarding/invitations'].includes(path)) ||
    (method === 'PATCH' && path === 'applicant/draft') ||
    (method === 'GET' && ['applicant/application','onboarding/invitations','onboarding/applications','onboarding/review-queue','onboarding/summary'].includes(path)) ||
    (method === 'GET' && /^onboarding\/applications\/[0-9a-f-]{36}$/.test(path)) ||
    (method === 'POST' && /^onboarding\/applications\/[0-9a-f-]{36}\/reviews$/.test(path)) ||
    (method === 'POST' && /^onboarding\/invitations\/[0-9a-f-]{36}\/revoke$/.test(path)) ||
    (method === 'POST'  && ['auth/login', 'auth/logout', 'users'].includes(path)) ||
    (method === 'GET' && ['auth/me', 'users'].includes(path)) ||
    (method === 'PATCH' && /^users\/[0-9a-f-]{36}$/.test(path)) ||
    (method === 'GET' && path === 'documents') || (method === 'POST' && path === 'documents') ||
    (method === 'POST' && (match(`applicant/photos/${PHOTO}`, path) || match(`applicant/documents/${ID}/sign`, path))) ||
    (method === 'GET' && isFileEndpoint(path));
}
export function isFileEndpoint(path: string): boolean { return FILE_ROUTES.some(pattern => match(pattern, path)); }
/** Request body limits in bytes. Photo and PDF uploads stay under Vercel's 4.5 MB function payload limit. */
export function bodyLimit(path: string): number {
  if (path === 'documents' || match(`applicant/photos/${PHOTO}`, path)) return 4_400_000;
  // Drawn signatures (applicant signing, NDA countersignature during approval).
  if (match(`applicant/documents/${ID}/sign`, path) || match(`onboarding/applications/${ID}/reviews`, path)) return 400_000;
  return 16384;
}
export function validMutation(headers: Headers, origin: string): boolean {
  return headers.get('origin') === origin && headers.get('x-csrf-protection') === '1' &&
    headers.get('content-type')?.split(';')[0].trim() === 'application/json' &&
    (!headers.get('sec-fetch-site') || headers.get('sec-fetch-site') === 'same-origin');
}
