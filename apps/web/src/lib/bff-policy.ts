// Transport/CSRF checks only. Business permissions remain in NestJS.
const ID = '[0-9a-f-]{36}', PHOTO = '(selfie|id-selfie)';
const match = (pattern: string, path: string) => new RegExp(`^${pattern}$`).test(path);
// Private files served as-is (JPEG photos and PDFs) instead of JSON.
const FILE_ROUTES = [`applicant/photos/${PHOTO}`, `applicant/documents/${ID}/(file|signed)`, `documents/${ID}/file`,
  `onboarding/applications/${ID}/photos/${PHOTO}`, `onboarding/applications/${ID}/documents/${ID}/signed`, `it/onboarding/${ID}/photo`,
  `dispatch/members/${ID}/photos/${PHOTO}`, `dispatch/members/${ID}/documents/${ID}/signed`, `dispatch/members/${ID}/paper-scans/${ID}/file`, `driver/documents/${ID}/file`, `driver/catch-up/documents/${ID}/file`, 'driver/contract/file', 'driver/contract/signed', `safety/drivers/${ID}/contracts/${ID}/signed`, `safety/owners/${ID}/contracts/${ID}/file`, `safety/drivers/${ID}/documents/${ID}/file`, `safety/drivers/${ID}/reports/${ID}/file`, `safety/drivers/${ID}/trucks/${ID}/documents/${ID}/file`,
  `safety/consents/${ID}/file`, `safety/letters/${ID}/file`, `safety/units/${ID}/files/${ID}/file`, `safety/drivers/${ID}/letters/(pre-adverse|final)`, `safety/drivers/${ID}/consents/${ID}/signed`, `driver/consents/${ID}/(file|signed)`];
const SCAN = '(license|medical-card|work-authorization|return-to-duty)';
export function allowedEndpoint(method: string, path: string): boolean {
  return (method === 'GET' && ['it/onboarding','notifications'].includes(path)) ||
    (method === 'GET' && /^it\/onboarding\/[0-9a-f-]{36}$/.test(path)) ||
    (method === 'PATCH' && /^it\/onboarding\/[0-9a-f-]{36}\/(contact|tasks\/[A-Z_]+)$/.test(path)) ||
    (method === 'POST' && /^notifications\/[0-9a-f-]{36}\/read$/.test(path)) ||
    // IT tasks (setups and removals together) and the removal checklist after a dispatcher left.
    (method === 'GET' && match(`it/removals/${ID}`, path)) || (method === 'PATCH' && match(`it/removals/${ID}/tasks/[A-Z_]+`, path)) ||
    // Leave: suspending accounts while someone is away, and restoring them.
    (method === 'GET' && match(`it/leave/${ID}`, path)) || (method === 'PATCH' && match(`it/leave/${ID}/tasks/[A-Z_]+`, path)) ||
    // A team lead's sign-in: create it, turn it back on or turn it off.
    (method === 'POST' && match(`it/sign-ins/${ID}`, path)) ||
    // Handing an application to another manager, and a manager's open records before their account changes.
    (method === 'POST' && match(`onboarding/applications/${ID}/manager`, path)) || (method === 'GET' && match(`users/${ID}/open-records`, path)) ||
    (method === 'POST' && ['applicant/begin','applicant/verify','applicant/submit','applicant/logout','onboarding/invitations'].includes(path)) ||
    (method === 'PATCH' && ['applicant/draft','applicant/updates'].includes(path)) ||
    // Applicant status updates: chosen channels and the Telegram connect link.
    (method === 'GET' && path === 'applicant/updates') ||
    (method === 'POST' && ['applicant/updates/telegram','applicant/updates/telegram/check','applicant/updates/telegram/disconnect'].includes(path)) ||
    (method === 'GET' && ['applicant/application','onboarding/invitations','onboarding/applications','onboarding/review-queue','onboarding/summary'].includes(path)) ||
    // The Dispatchers filters ask how many people the filters being chosen would show (DispatchersFilterSheetPhoneScreen).
    (method === 'GET' && path === 'dispatch/members') ||
    (method === 'GET' && /^onboarding\/applications\/[0-9a-f-]{36}$/.test(path)) ||
    (method === 'POST' && /^onboarding\/applications\/[0-9a-f-]{36}\/reviews$/.test(path)) ||
    (method === 'POST' && /^onboarding\/invitations\/[0-9a-f-]{36}\/revoke$/.test(path)) ||
    (method === 'POST'  && ['auth/login', 'auth/logout', 'users'].includes(path)) ||
    // Own password: the forced change after an administrator-set password, or a change from Account security.
    (method === 'POST' && path === 'auth/password') ||
    (method === 'GET' && ['auth/me', 'users'].includes(path)) ||
    // Staff two-step verification: sign-in step, enrolment, own settings, administrator reset and policy.
    (method === 'POST' && ['auth/mfa/verify', 'auth/mfa/challenge', 'auth/mfa/enrolment', 'auth/mfa/enrolment/confirm', 'auth/mfa/email-code', 'auth/mfa/recovery-codes', 'auth/mfa/disable', 'auth/mfa/replacement', 'auth/mfa/replacement/confirm', 'auth/mfa/devices/forget-all'].includes(path)) ||
    // Devices that skip the sign-in code (section 38).
    (method === 'POST' && match(`auth/mfa/devices/${ID}/forget`, path)) ||
    (method === 'GET' && ['auth/mfa', 'auth/mfa/methods', 'auth/mfa/devices', 'settings/security'].includes(path)) || (method === 'PATCH' && path === 'settings/security') ||
    (method === 'POST' && match(`users/${ID}/mfa/reset`, path)) ||
    (method === 'PATCH' && /^users\/[0-9a-f-]{36}$/.test(path)) ||
    // The approver's own saved countersigning signature.
    // Own Telegram connection for workspace alerts.
    (method === 'GET' && path === 'staff/telegram') || (method === 'POST' && ['staff/telegram/connect', 'staff/telegram/check', 'staff/telegram/disconnect'].includes(path)) ||
    (method === 'GET' && path === 'staff/signature') || (method === 'POST' && ['staff/signature', 'staff/signature/delete'].includes(path)) ||
    (method === 'GET' && path === 'documents') || (method === 'POST' && path === 'documents') ||
    // Managed lists: add, edit, archive and restore MCs and job titles.
    (method === 'POST' && ['lists/mcs', 'lists/job-titles'].includes(path)) || (method === 'PATCH' && match(`lists/(mcs|job-titles)/${ID}`, path)) ||
    // Dispatchers table: export the view on screen (recorded, so a POST).
    (method === 'POST' && path === 'dispatch/members/export') ||
    // Teams and dispatch members: add and edit teams, move a dispatcher, mark them as left, change their job title.
    (method === 'POST' && (path === 'dispatch/teams' || match(`dispatch/members/${ID}/(move|place|start-date|support-type|leave|last-day|cancel-notice|remove-access|contacts|reassign|it-setup|correct|left-day|close-accounts|names|on-leave|on-leave/(return|cancel|back-on|reason))`, path) || match(`dispatch/members/${ID}/contacts/${ID}/remove`, path))) ||
    (method === 'PATCH' && match(`dispatch/(teams|members)/${ID}`, path)) ||
    // People already working here: check and add them, their paperwork and catch-up links, what a manager recorded.
    (method === 'POST' && ['dispatch/existing/check', 'dispatch/existing/add', 'dispatch/paperwork/links'].includes(path)) || (method === 'PATCH' && match(`dispatch/members/${ID}/existing`, path)) || (method === 'POST' && match(`dispatch/members/${ID}/more-time`, path)) ||
    // A scan of an NDA or SOP signed on paper (section 38).
    (method === 'POST' && match(`dispatch/members/${ID}/paper-scans`, path)) ||
    // Cleared drivers: a dispatch manager (anywhere) or a team lead (in their teams) assigns an MC and a dispatcher.
    (method === 'POST' && match(`(dispatch|team)/drivers/${ID}/assign`, path)) ||
    // Promotions: a team lead's request or cancellation, and a manager's decision.
    (method === 'POST' && (path === 'team/promotions' || match(`team/promotions/${ID}/cancel`, path) || match(`dispatch/promotions/${ID}/decide`, path))) ||
    // Safety drivers: add and edit a driver, withdraw or reopen them, assign their safety staff owner.
    (method === 'POST' && (path === 'safety/drivers' || match(`safety/drivers/${ID}/(withdraw|reopen|owner|left|link|link/cancel|ssn|annual-reviews|tests|incidents)`, path))) ||
    // A driver filling in their application (driver session cookie; no staff account).
    (method === 'POST' && (['driver/begin', 'driver/verify', 'driver/application/submit', 'driver/logout'].includes(path) || match(`driver/documents/${SCAN}`, path))) ||
    // Renewing a license or medical card: upload it, send or cancel the driver's link, mark their scan as not readable.
    (method === 'POST' && match(`safety/drivers/${ID}/(documents/renew|renewals|renewals/cancel|documents/${ID}/unreadable)`, path)) ||
    // A driver's renewal link: which document, and sending its scan.
    ((method === 'GET' || method === 'POST') && path === 'driver/renewal') ||
    // An existing driver's catch-up link (section 34): photos of current documents and the current forms.
    (method === 'GET' && path === 'driver/catch-up') ||
    // Contract links (section 39): the one acknowledgement, for the driver or the truck owner's signer; and Safety's side of it and Ready for the road.
    (method === 'GET' && path === 'driver/contract') || (method === 'POST' && ['driver/contract/view', 'driver/contract/sign'].includes(path)) ||
    (method === 'POST' && match(`safety/drivers/${ID}/(contracts|contracts/${ID}/owner-link|contracts/${ID}/cancel|road-ready/unit|road-ready/[A-Z_]+|group-changes/${ID}/done)`, path)) ||
    (method === 'POST' && match(`safety/owners/${ID}/contracts`, path)) || (method === 'POST' && (path === 'driver/catch-up/send' || match(`driver/catch-up/documents/${SCAN}`, path))) ||
    (method === 'POST' && (['safety/drivers/existing/check', 'safety/drivers/existing/add'].includes(path) || match(`safety/drivers/${ID}/(paper/[A-Z_]+|catch-up|catch-up/cancel)`, path))) ||
    // Expiration reminders on Telegram: the driver connects their own chat; Safety makes a one-time link to send.
    (method === 'GET' && path === 'driver/telegram') || (method === 'POST' && ['driver/telegram/connect', 'driver/telegram/check'].includes(path)) ||
    (method === 'POST' && match(`safety/drivers/${ID}/telegram-link`, path)) ||
    (method === 'POST' && (match(`safety/drivers/${ID}/documents/${ID}/verify`, path) || match(`safety/drivers/${ID}/(tests|incidents)/${ID}/void`, path) || match(`safety/drivers/${ID}/incidents/${ID}/settle`, path))) ||
    // Screening (checks, the MVR, corrections, the hand-off) and the Safety manager's decision.
    (method === 'POST' && match(`safety/drivers/${ID}/(checks/[A-Z_]+|mvr|psp|road-test|corrections|send-for-decision|decision)`, path)) ||
    // Owner-operators' trucks: add, change, archive, and upload a lease, insurance or registration PDF.
    (method === 'POST' && match(`safety/drivers/${ID}/trucks(/${ID}(/archive|/documents)?)?`, path)) ||
    // Units, trailers and truck owners (section 34).
    (method === 'POST' && (['safety/units', 'safety/units/check', 'safety/units/add', 'safety/units/permits/renew', 'safety/owners'].includes(path) || match(`safety/units/${ID}/(dates|status|responsible|files)`, path) || match(`safety/owners/${ID}/archive`, path))) ||
    (method === 'PATCH' && (match(`safety/units/${ID}`, path) || match(`safety/owners/${ID}`, path))) ||
    // Clearance of an approved driver: checklist items, previous employers and Cleared.
    (method === 'POST' && match(`safety/drivers/${ID}/(clearance/[A-Z_]+|employers|employers/${ID}|employers/${ID}/remove|clear)`, path)) ||
    // Driver consent forms: the Safety manager publishes them; a driver opens and signs them in their application.
    (method === 'POST' && (path === 'safety/consents' || path === 'safety/letters' || match(`driver/consents/${ID}/(view|sign)`, path))) ||
    ((method === 'GET' || method === 'PATCH') && path === 'driver/application') || (method === 'PATCH' && match(`safety/drivers/${ID}`, path)) ||
    (method === 'POST' && (match(`applicant/photos/${PHOTO}`, path) || match(`applicant/documents/${ID}/(view|sign|acknowledge)`, path))) ||
    (method === 'GET' && isFileEndpoint(path));
}
const LIST_QUERY = ['page', 'pageSize', 'status', 'search', 'sort', 'direction'];
/** The query fields passed on to the API for a list read through the BFF; anything else is dropped. */
export function forwardedQuery(path: string): string[] {
  if (path === 'onboarding/review-queue' || path === 'it/onboarding') return LIST_QUERY;
  if (path === 'dispatch/members') return [...LIST_QUERY, 'mcId', 'teamId', 'leadId', 'jobTitleId', 'position', 'source', 'drivers', 'only'];
  return [];
}
export function isFileEndpoint(path: string): boolean { return FILE_ROUTES.some(pattern => match(pattern, path)); }
/** Request body limits in bytes. Photo and PDF uploads stay under Vercel's 4.5 MB function payload limit. */
export function bodyLimit(path: string): number {
  if (path === 'documents' || match(`applicant/photos/${PHOTO}`, path) || match(`driver/documents/${SCAN}`, path) || match(`driver/catch-up/documents/${SCAN}`, path) || path === 'driver/renewal' || match(`safety/owners/${ID}/contracts`, path) || match(`safety/drivers/${ID}/(mvr|psp|road-test|annual-reviews|documents/renew)`, path) || match(`safety/drivers/${ID}/trucks/${ID}/documents`, path) || match(`safety/units/${ID}/files`, path) || match(`dispatch/members/${ID}/paper-scans`, path) || path === 'safety/consents' || path === 'safety/letters') return 4_400_000;
  // A list of existing dispatchers, units or drivers, up to 500 rows of text.
  if (['dispatch/existing/check', 'dispatch/existing/add', 'safety/units/check', 'safety/units/add', 'safety/drivers/existing/check', 'safety/drivers/existing/add'].includes(path)) return 1_000_000;
  // Signature images (applicant signing, NDA countersignature during approval, a saved staff signature).
  if (match(`applicant/documents/${ID}/sign`, path) || match(`driver/consents/${ID}/sign`, path) || path === 'driver/contract/sign' || match(`onboarding/applications/${ID}/reviews`, path) || path === 'staff/signature') return 400_000;
  return 16384;
}
export function validMutation(headers: Headers, origins: string[]): boolean {
  return origins.includes(headers.get('origin') ?? '') && headers.get('x-csrf-protection') === '1' &&
    headers.get('content-type')?.split(';')[0].trim() === 'application/json' &&
    (!headers.get('sec-fetch-site') || headers.get('sec-fetch-site') === 'same-origin');
}
