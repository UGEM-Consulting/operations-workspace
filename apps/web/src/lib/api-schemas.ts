import { z } from 'zod';
// Structural checks at the server-side API boundary. A response that does not match fails here with a clear
// error (caught by the nearest error.tsx) instead of crashing deep in render. Objects are loose, so fields not
// listed here still reach the page; the parsed value is returned, where only a `.catch()` fallback differs from
// the original. Only the shape is checked; no response value is ever included in the error.

const text = z.string();
const nullableText = z.string().nullable();
const fields = z.record(z.string(), z.unknown());

export class ApiResponseError extends Error {
  constructor(readonly resource: string) { super(`Unexpected ${resource} response`); this.name = 'ApiResponseError'; }
}

// Returns the parsed value: loose objects keep every field, and a `.catch()` fallback (an optional field from a newer
// or older API that fails its check) replaces only that field.
export function parseResponse<T>(schema: z.ZodType, data: unknown, resource: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new ApiResponseError(resource);
  return result.data as T;
}

/** GET /auth/me */
export const identitySchema = z.looseObject({
  user: z.looseObject({ id: text, firstName: text, lastName: text, email: text, role: text, status: text, mfaEnabled: z.boolean().optional() }),
  navigation: z.array(z.looseObject({ key: text, href: text.startsWith('/'), label: text, section: text.nullable().optional() })),
  landingPage: text.startsWith('/'),
});
/** GET /workspace/counts: sidebar counts and unread notifications (null when the role has none). */
export const workspaceCountsSchema = z.looseObject({ navigation: z.record(z.string(), z.number().int().nonnegative()), unreadNotifications: z.number().int().nonnegative().nullable() });

/** GET /auth/mfa (account security). */
// Own saved countersigning signature (managers and administrators).
export const savedSignatureSchema = z.looseObject({ saved: z.looseObject({ typedName: text, signatureMethod: z.enum(['DRAWN', 'TYPED']), updatedAt: text, image: z.string().startsWith('data:image/png;base64,') }).nullable() });
export const mfaStatusSchema = z.looseObject({ enabled: z.boolean(), required: z.boolean(), policy: text, enabledAt: nullableText, recoveryCodesRemaining: z.number(),
  // Absent from an older API: treated as an authenticator app with email codes unavailable.
  method: z.enum(['TOTP', 'EMAIL']).nullable().optional(), emailCodesAvailable: z.boolean().optional(), email: text.optional() });

/** GET /staff/telegram: own Telegram alert connection. */
export const staffTelegramSchema = z.looseObject({ available: z.boolean(), connected: z.boolean(), username: nullableText, alerts: z.array(z.enum(['REVIEW_WAITING', 'IT_SETUP_WAITING'])) });

/** GET /onboarding/applications/:id */
export const reviewDetailSchema = z.looseObject({
  application: z.looseObject({ id: text, status: text, fields, version: z.number(), submittedAt: nullableText }),
  invitation: z.looseObject({ id: text, email: nullableText, mcName: nullableText, teamLead: nullableText, jobTitle: nullableText }),
  reviews: z.array(z.looseObject({ id: text, decisionType: text, createdAt: text, requestedFields: z.array(text) })),
  submissions: z.array(z.looseObject({ id: text, fields, createdAt: text })),
  activity: z.array(z.looseObject({ id: text, event: text, createdAt: text })),
  canReview: z.boolean(), canReject: z.boolean().optional(), readyForIt: z.boolean(), requiredFields: z.array(text),
  itOnboarding: z.looseObject({ id: text, status: text }).nullable(),
  documents: z.looseObject({ required: z.boolean(), items: z.array(z.looseObject({ kind: text })), photos: z.looseObject({}) }),
  itDetails: z.looseObject({ proposedDisplayName: nullableText }),
  // Only while a decision is possible, from an API with managed lists. A malformed value is dropped, so the review
  // falls back to text inputs instead of failing.
  employmentOptions: z.looseObject({
    mcs: z.array(z.looseObject({ id: text, name: text })), jobTitles: z.array(z.looseObject({ id: text, name: text })),
    teams: z.array(z.looseObject({ id: text, name: text, mcId: text, lead: nullableText })),
  }).nullable().optional().catch(undefined),
  // A support application: the dispatcher they will assist (from an API with supports).
  supports: z.looseObject({ supportsMemberId: nullableText, options: z.array(z.looseObject({ id: text, name: text, status: text, mc: nullableText, team: nullableText })) }).nullable().optional(),
});

/** GET /onboarding/invitations */
export const invitationListSchema = z.array(z.looseObject({ id: text, status: text, email: nullableText, expectedEmail: nullableText, expiresAt: text, createdAt: text, position: text.optional() }));

/** GET /lists/mcs and /lists/job-titles (Admin › Lists, and choices in dispatch forms). */
export const managedListSchema = z.looseObject({
  items: z.array(z.looseObject({ id: text, name: text, archived: z.boolean(), version: z.number(), usage: z.number().optional() })),
  counts: z.looseObject({ active: z.number(), archived: z.number() }),
});
/** GET /lists/... when only the choices are used (id, name, archived). */
export const choiceListSchema = z.looseObject({ items: z.array(z.looseObject({ id: text, name: text, archived: z.boolean() })) });

/** GET /dispatch/teams */
export const teamListSchema = z.looseObject({
  items: z.array(z.looseObject({ id: text, name: text, version: z.number(), archived: z.boolean(), mc: z.looseObject({ id: text, name: text }), lead: z.looseObject({ id: text, name: text }).nullable(), members: z.number() })),
  counts: z.looseObject({ active: z.number(), archived: z.number() }),
});

const memberRow = z.looseObject({ id: text, firstName: text, lastName: text, position: text, status: text, version: z.number(), mc: nullableText, team: nullableText, since: nullableText });
/** GET /dispatch/members */
export const memberListSchema = z.looseObject({ items: z.array(memberRow) });
const assignment = z.looseObject({ id: text, startedAt: text, endedAt: nullableText, mcId: nullableText, mc: nullableText, teamId: nullableText, team: nullableText });
const supportLink = z.looseObject({ id: text, startedAt: text, endedAt: nullableText, dispatcherId: text, dispatcher: text });
/** GET /dispatch/members/:id */
export const memberProfileSchema = z.looseObject({
  id: text, firstName: text, lastName: text, position: text, status: text, version: z.number(), joinedAt: text, leftAt: nullableText,
  jobTitle: z.looseObject({ id: text, name: text }).nullable(), current: assignment.nullable(), history: z.array(assignment), leadOf: z.looseObject({ id: text, name: text }).nullable(),
  accounts: z.looseObject({}).nullable(),
  // From an API with full dispatcher details and supports; absent on an older one.
  details: z.looseObject({}).nullable().optional(), contacts: z.array(z.looseObject({ id: text, kind: text, value: text, createdAt: text })).optional(),
  documents: z.array(z.looseObject({ id: text, kind: text, title: text, signedAt: text })).optional(), activity: z.array(z.looseObject({ id: text, event: text, createdAt: text })).optional(),
  supportOf: supportLink.nullable().optional(), supportHistory: z.array(supportLink).optional(), supports: z.array(z.looseObject({ id: text, name: text, status: text, since: text })).optional(),
});

/** GET /team: a team lead's own team. */
export const teamViewSchema = z.looseObject({
  teams: z.array(z.looseObject({ id: text, name: text, mc: text })),
  dispatchers: z.array(z.looseObject({ id: text, name: text, status: text, teamId: text, lead: z.boolean() })),
  supports: z.array(z.looseObject({ id: text, name: text, status: text, dispatcherId: text, since: text, pending: z.looseObject({ id: text, createdAt: text }).nullable() })),
  requests: z.array(z.looseObject({ id: text, status: text, reason: text, note: nullableText, createdAt: text, support: text })),
});
/** GET /dispatch/promotions */
export const promotionListSchema = z.looseObject({ items: z.array(z.looseObject({ id: text, status: text, version: z.number(), createdAt: text })) });

const safetyPerson = z.looseObject({ id: text, name: text }).nullable();
const driverRow = z.looseObject({ id: text, firstName: text, lastName: text, phone: text, email: nullableText, driverType: text, status: text, version: z.number(), createdAt: text,
  closedAt: nullableText, safetyLead: safetyPerson, owner: safetyPerson });
/** GET /safety/people: who can be a driver's Safety lead or owner. */
export const safetyPeopleSchema = z.looseObject({ leads: z.array(z.looseObject({ id: text, name: text, role: text })), staff: z.array(z.looseObject({ id: text, name: text, role: text })) });
/** GET /safety/drivers */
export const driverListSchema = z.looseObject({ items: z.array(driverRow) });
/** GET /safety/drivers/:id */
export const driverProfileSchema = driverRow.extend({
  owners: z.array(z.looseObject({ id: text, startedAt: text, endedAt: nullableText, owner: safetyPerson })),
  activity: z.array(z.looseObject({ id: text, event: text, createdAt: text, metadata: z.looseObject({}) })),
  // From an API with driver applications and document scans; absent on an older one.
  link: z.looseObject({ email: text, createdAt: text, expiresAt: text, openedAt: nullableText, expired: z.boolean() }).nullable().optional(),
  application: z.looseObject({ status: text, fields, ssnLast4: nullableText, version: z.number(), submittedAt: nullableText }).nullable().optional(),
  documents: z.array(z.looseObject({ id: text, kind: text, pageCount: z.number(), createdAt: text, verifiedAt: nullableText })).optional(),
  // From an API with screening and decisions. A malformed value is dropped, so the profile still loads without it.
  screening: z.looseObject({
    checks: z.array(z.looseObject({ key: text, result: z.enum(['PASS', 'CONCERN']), note: nullableText, checkedAt: text, checkedBy: nullableText })),
    mvr: z.looseObject({ id: text, pulledOn: text, pageCount: z.number(), createdAt: text }).nullable(),
    reviews: z.array(z.looseObject({ id: text, action: text, note: nullableText, conditions: nullableText, noticeSentOn: nullableText, createdAt: text, actor: nullableText })),
    missing: z.array(text), finalRejectionFrom: nullableText,
  }).optional().catch(undefined),
});

/** GET /it/onboarding/:id */
export const itDetailSchema = z.looseObject({
  request: z.looseObject({ id: text, version: z.number(), status: text, profile: z.looseObject({ mcName: text, teamLead: text, jobTitle: text }), completedAt: nullableText }),
  tasks: z.array(z.looseObject({ id: text, key: text, label: text, status: text, optional: z.boolean() })),
  activity: z.array(z.looseObject({ id: text, event: text, createdAt: text, metadata: z.record(z.string(), z.unknown()) })),
});

/** Reads a server-side API response body as JSON and checks its shape; neither failure exposes the body. */
export async function readResponse<T>(response: Response, resource: string, schema?: z.ZodType): Promise<T> {
  let data: unknown;
  try { data = await response.json(); } catch { throw new ApiResponseError(resource); }
  return schema ? parseResponse<T>(schema, data, resource) : data as T;
}
