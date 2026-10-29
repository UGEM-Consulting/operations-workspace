import { z } from 'zod';
// Structural checks at the server-side API boundary. A response that does not match fails here with a clear
// error (caught by the nearest error.tsx) instead of crashing deep in render. Objects are loose: the original
// value is returned untouched, so fields not listed here still reach the page. Only the shape is checked;
// no response value is ever included in the error.

const text = z.string();
const nullableText = z.string().nullable();
const fields = z.record(z.string(), z.unknown());

export class ApiResponseError extends Error {
  constructor(readonly resource: string) { super(`Unexpected ${resource} response`); this.name = 'ApiResponseError'; }
}

export function parseResponse<T>(schema: z.ZodType, data: unknown, resource: string): T {
  if (!schema.safeParse(data).success) throw new ApiResponseError(resource);
  return data as T;
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
export const mfaStatusSchema = z.looseObject({ enabled: z.boolean(), required: z.boolean(), policy: text, enabledAt: nullableText, recoveryCodesRemaining: z.number() });

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
