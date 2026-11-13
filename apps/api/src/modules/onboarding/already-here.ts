import { BadRequestException, ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { onLeaveSql } from '../dispatch/create-member';

/**
 * Already here (section 37, designed and approved 2026-11-11): an applicant's verified email, and their personal phone once
 * submitted, compared with everyone in the workspace and with other open applications. It warns rather than blocks, except
 * where one person would get two records: a second open application with the same email is refused at verification, and an
 * approval is refused when the email belongs to someone who works here now. Nothing is stored and no event is written.
 */
type Query = Pick<EntityManager, 'query'>;
export type MatchOn = 'EMAIL' | 'PHONE';
export interface HereMatch {
 on: MatchOn;
 // A person's record, or another application nobody has decided yet (shown without the applicant's name).
 kind: 'MEMBER' | 'APPLICATION';
 memberId: string | null; name: string | null; position: string | null; supportType: string | null;
 // ONBOARDING, ACTIVE, ON_LEAVE or LEFT for a person; the application's status otherwise.
 status: string; leftAt: string | null;
 applicationId: string | null; manager: string | null;
}
export interface Probe { key: string; email: string | null; phone: string | null; applicationId: string | null; skipMemberId: string | null }

/** Digits only, without a leading US 1: the file import's rule (existing.service.ts digits). */
export const phoneKey = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') || null;
const phoneSql = (expr: string) => `nullif(regexp_replace(regexp_replace(coalesce(${expr}, ''), '\\D', '', 'g'), '^1(?=\\d{10}$)', ''), '')`;
// Undecided and not given up: one waiting for review counts however long ago the applicant's access ended.
const OPEN_APPLICATION = `a.status NOT IN ('APPROVED','REJECTED') AND i."revokedAt" IS NULL AND i."consumedAt" IS NOT NULL AND (a.status IN ('SUBMITTED','RESUBMITTED') OR a."applicantAccessUntil" > now())`;
// Submissions whose phone matched and that are their application's latest, as a table to join: the phone index
// (IDX_application_submissions_phone, the same expression) finds them without reading every submission.
const SUBMITTED_PHONE = (phone: (value: string) => string) => `(SELECT s.* FROM application_submissions s WHERE ${phone(phoneSql(`s.fields->>'personalPhoneNumber'`))}
   AND NOT EXISTS (SELECT 1 FROM application_submissions n WHERE n."applicationId" = s."applicationId" AND n.version > s.version)) s`;

/**
 * Every way to reach a person, current values only: their application (or an administrator's correction of it), what a manager
 * recorded by hand, added contacts and the company email IT recorded. Load board sign-ins are shared, so never compared.
 * Each part is filtered by the wanted emails ($2) or phones ($3) itself, and phone parts are left out when no phone is asked.
 */
function points(emails: boolean, phones: boolean) {
 const email = (value: string) => `${value} = ANY($2::text[])`, phone = (value: string) => `${value} = ANY($3::text[])`;
 const parts: string[] = [];
 if (emails) parts.push(
  `SELECT d.id AS "memberId", NULL::uuid AS "applicationId", 'EMAIL' AS kind, lower(coalesce(d."correctedDetails"->>'personalEmail', i.email)) AS value
   FROM dispatch_members d JOIN dispatcher_applications a ON a.id = d."applicationId" JOIN invitations i ON i.id = a."invitationId" WHERE ${email(`lower(coalesce(d."correctedDetails"->>'personalEmail', i.email))`)}`,
  `SELECT e."memberId", NULL, 'EMAIL', lower(e."personalEmail") FROM existing_member_records e WHERE ${email('lower(e."personalEmail")')}`,
  `SELECT e."memberId", NULL, 'EMAIL', lower(e."companyEmail") FROM existing_member_records e WHERE ${email('lower(e."companyEmail")')}`,
  `SELECT c."memberId", NULL, 'EMAIL', lower(c.value) FROM member_contacts c WHERE c."removedAt" IS NULL AND c.kind = 'EMAIL' AND ${email('lower(c.value)')}`,
  `SELECT coalesce(r."memberId", d.id), NULL, 'EMAIL', lower(r."companyEmail") FROM it_onboarding_requests r LEFT JOIN dispatch_members d ON d."applicationId" = r."applicationId"
   WHERE r."cancelledAt" IS NULL AND ${email('lower(r."companyEmail")')}`,
  `SELECT NULL, a.id, 'EMAIL', lower(i.email) FROM dispatcher_applications a JOIN invitations i ON i.id = a."invitationId" WHERE ${OPEN_APPLICATION} AND ${email('lower(i.email)')}`);
 if (phones) parts.push(
  // An administrator's correction replaces the application's phone (currentDetails), so each side checks the other isn't there.
  `SELECT d.id AS "memberId", NULL::uuid AS "applicationId", 'PHONE' AS kind, ${phoneSql(`d."correctedDetails"->>'personalPhoneNumber'`)} AS value
   FROM dispatch_members d WHERE d."applicationId" IS NOT NULL AND d."correctedDetails" ? 'personalPhoneNumber' AND ${phone(phoneSql(`d."correctedDetails"->>'personalPhoneNumber'`))}`,
  `SELECT d.id, NULL, 'PHONE', ${phoneSql(`s.fields->>'personalPhoneNumber'`)} FROM ${SUBMITTED_PHONE(phone)}
   JOIN dispatch_members d ON d."applicationId" = s."applicationId" WHERE NOT d."correctedDetails" ? 'personalPhoneNumber'`,
  `SELECT e."memberId", NULL, 'PHONE', ${phoneSql('e."personalPhone"')} FROM existing_member_records e WHERE ${phone(phoneSql('e."personalPhone"'))}`,
  `SELECT c."memberId", NULL, 'PHONE', ${phoneSql('c.value')} FROM member_contacts c WHERE c."removedAt" IS NULL AND c.kind = 'PHONE' AND ${phone(phoneSql('c.value'))}`,
  `SELECT NULL, a.id, 'PHONE', ${phoneSql(`s.fields->>'personalPhoneNumber'`)} FROM ${SUBMITTED_PHONE(phone)}
   JOIN dispatcher_applications a ON a.id = s."applicationId" JOIN invitations i ON i.id = a."invitationId" WHERE ${OPEN_APPLICATION} AND a."submittedAt" IS NOT NULL`);
 return parts.join('\n UNION ALL ');
}

/** Matches for each probe, people first (current before left), then applications. */
export async function alreadyHere(db: Query, probes: Probe[]): Promise<Map<string, HereMatch[]>> {
 const result = new Map<string, HereMatch[]>(probes.map(probe => [probe.key, []]));
 const wanted = probes.map(probe => ({ key: probe.key, email: probe.email?.trim().toLowerCase() || null, phone: phoneKey(probe.phone), applicationId: probe.applicationId, skipMemberId: probe.skipMemberId }))
  .filter(probe => probe.email || probe.phone);
 if (!wanted.length) return result;
 const emails = [...new Set(wanted.map(probe => probe.email).filter(Boolean))], phones = [...new Set(wanted.map(probe => probe.phone).filter(Boolean))];
 // Both lists are typed up front: PostgreSQL refuses a parameter the query never uses (phones on Invitations).
 const rows: (HereMatch & { key: string })[] = await db.query(`WITH wanted AS (SELECT $2::text[] AS emails, $3::text[] AS phones), points AS (${points(emails.length > 0, phones.length > 0)}), probes AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(key text, email text, phone text, "applicationId" uuid, "skipMemberId" uuid))
  SELECT DISTINCT ON (p.key, coalesce(x."memberId", x."applicationId"), x.kind) p.key, x.kind AS "on", CASE WHEN x."memberId" IS NULL THEN 'APPLICATION' ELSE 'MEMBER' END AS kind,
   d.id AS "memberId", CASE WHEN d.id IS NULL THEN NULL ELSE d."firstName" || ' ' || d."lastName" END AS name, d.position, d."supportType",
   CASE WHEN d.id IS NULL THEN a.status WHEN d.status = 'LEFT' THEN 'LEFT'
    WHEN ${onLeaveSql('d')} THEN 'ON_LEAVE' ELSE d.status END AS status,
   -- Someone added as Left with no last day holds the day they were added there, which is never shown as a date.
   CASE WHEN (SELECT e."leftDateKnown" FROM existing_member_records e WHERE e."memberId" = d.id) IS FALSE THEN NULL ELSE d."leftAt" END AS "leftAt", x."applicationId", CASE WHEN u.id IS NULL THEN NULL ELSE u."firstName" || ' ' || u."lastName" END AS manager
  FROM probes p JOIN points x ON x.value IS NOT NULL AND ((x.kind = 'EMAIL' AND x.value = p.email) OR (x.kind = 'PHONE' AND x.value = p.phone))
  LEFT JOIN dispatch_members d ON d.id = x."memberId" LEFT JOIN dispatcher_applications a ON a.id = x."applicationId" LEFT JOIN users u ON u.id = a."assignedManagerId"
  WHERE (x."applicationId" IS NULL OR x."applicationId" IS DISTINCT FROM p."applicationId")
   AND (d.id IS NULL OR (d.id IS DISTINCT FROM p."skipMemberId" AND d."applicationId" IS DISTINCT FROM p."applicationId"))
  ORDER BY p.key, coalesce(x."memberId", x."applicationId"), x.kind`, [JSON.stringify(wanted), emails, phones]);
 const rank = (match: HereMatch) => match.kind === 'APPLICATION' ? 3 : match.status === 'LEFT' ? 2 : 1;
 for (const { key, ...match } of rows) result.get(key)!.push({ ...match, leftAt: match.leftAt ? new Date(match.leftAt).toISOString() : null });
 for (const list of result.values()) list.sort((a, b) => rank(a) - rank(b) || (a.on === b.on ? 0 : a.on === 'EMAIL' ? -1 : 1) || (a.name ?? '').localeCompare(b.name ?? ''));
 return result;
}

/**
 * At verification: someone already filling in an application with this email continues that one instead. Claims of the same
 * email wait for each other (advisory lock 42002039 per email, after the invitation's row lock), so two links verified at the
 * same moment can't both pass.
 */
export async function refuseSecondApplication(db: Query, email: string, invitationId: string) {
 await db.query(`SELECT pg_advisory_xact_lock(42002039, hashtext($1))`, [email.toLowerCase()]);
 const [open] = await db.query(`SELECT 1 FROM dispatcher_applications a JOIN invitations i ON i.id = a."invitationId" WHERE ${OPEN_APPLICATION} AND lower(i.email) = $1 AND i.id <> $2 LIMIT 1`, [email.toLowerCase(), invitationId]);
 if (open) throw new ConflictException('You already have an application in progress with this email. Continue it with your application reference, or ask your manager.');
}

/**
 * At approval, inside the decision transaction: an email that belongs to someone here now (or on leave) refuses, a phone they
 * share needs differentPerson, and a returning person must be one of the people who left that this application matches.
 */
export function approvalMatches(matches: HereMatch[], input: { differentPerson?: boolean; returningMemberId?: string }) {
 const people = matches.filter(match => match.kind === 'MEMBER');
 const current = people.filter(match => match.status !== 'LEFT');
 const sameEmail = current.find(match => match.on === 'EMAIL');
 if (sameEmail) throw new BadRequestException(`Their email belongs to ${sameEmail.name}, who works here now. One person can’t have two records: reject this application, or ask an administrator to correct ${sameEmail.name}’s email if it’s wrong.`);
 const samePhone = current.find(match => match.on === 'PHONE');
 if (samePhone && !input.differentPerson) throw new BadRequestException(`Their phone matches ${samePhone.name}. Confirm they’re a different person before approving.`);
 if (!input.returningMemberId) return null;
 if (!people.some(match => match.status === 'LEFT' && match.memberId === input.returningMemberId)) throw new BadRequestException('Choose someone who left and matches this application.');
 return input.returningMemberId;
}
