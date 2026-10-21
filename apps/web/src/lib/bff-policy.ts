// Transport/CSRF checks only. Business permissions remain in NestJS.
export function allowedEndpoint(method: string, path: string): boolean {
  return (method === 'POST' && ['applicant/begin','applicant/verify','applicant/submit','applicant/logout','onboarding/invitations'].includes(path)) ||
    (method === 'PATCH' && path === 'applicant/draft') ||
    (method === 'GET' && ['applicant/application','onboarding/invitations','onboarding/applications','onboarding/review-queue','onboarding/summary'].includes(path)) ||
    (method === 'GET' && /^onboarding\/applications\/[0-9a-f-]{36}$/.test(path)) ||
    (method === 'POST' && /^onboarding\/applications\/[0-9a-f-]{36}\/reviews$/.test(path)) ||
    (method === 'POST' && /^onboarding\/invitations\/[0-9a-f-]{36}\/revoke$/.test(path)) ||
    (method === 'POST'  && ['auth/login', 'auth/logout', 'users'].includes(path)) ||
    (method === 'GET' && ['auth/me', 'users'].includes(path)) ||
    (method === 'PATCH' && /^users\/[0-9a-f-]{36}$/.test(path));
}
export function validMutation(headers: Headers, origin: string): boolean {
  return headers.get('origin') === origin && headers.get('x-csrf-protection') === '1' &&
    headers.get('content-type')?.split(';')[0].trim() === 'application/json' &&
    (!headers.get('sec-fetch-site') || headers.get('sec-fetch-site') === 'same-origin');
}
