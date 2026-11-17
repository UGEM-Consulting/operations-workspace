import { EntityManager } from 'typeorm';
import { driverDocumentKey, driverReportKey, memberPhotoKey, ownerDocumentKey, paperScanKey, photoKey, unitFileKey, type StorageLayout } from '../storage/storage.service';

/**
 * Deleting one person's records for good (section 34), inside the retention job's transaction (operations.retention set, so
 * signed evidence may go). Each returns the storage keys to remove once it commits. Audit rows stay with their subject set to
 * null by the database (RetentionJob1793300000000), and so does a driver's assignment history when a dispatcher's record goes.
 * Every reference to these records is handled here; KNOWN_REFERENCES lists them, and the job stops when the schema has one it
 * doesn't know, so a new table is never deleted from (or left blocking) by surprise.
 */
type Q = Pick<EntityManager, 'query'>;
const ids = (rows: { id: string }[]) => rows.map(row => row.id);

/** A dispatcher application and its invitation: answers, photos, signatures and their saved copies, reviews, and IT setup. */
export async function deleteApplication(em: Q, applicationId: string): Promise<string[]> {
  const [application]: { invitationId: string }[] = await em.query(`SELECT "invitationId" FROM dispatcher_applications WHERE id = $1`, [applicationId]);
  if (!application) return [];
  const photos: { id: string; kind: string; storageLayout: StorageLayout }[] = await em.query(`SELECT id, kind, "storageLayout" FROM applicant_photos WHERE "applicationId" = $1`, [applicationId]);
  const copies: { storageKey: string }[] = await em.query(`SELECT "storageKey" FROM signed_copies WHERE "applicationId" = $1`, [applicationId]);
  const keys = [...photos.map(photo => photoKey({ ...photo, applicationId })), ...copies.map(copy => copy.storageKey)];
  await deleteSetups(em, ids(await em.query(`SELECT id FROM it_onboarding_requests WHERE "applicationId" = $1`, [applicationId])));
  for (const table of ['notification_deliveries', 'applicant_update_deliveries', 'applicant_update_settings', 'telegram_link_tokens', 'document_views', 'signed_copies', 'document_signatures', 'applicant_photos',
    'application_submissions', 'application_manager_changes', 'application_reviews']) await em.query(`DELETE FROM ${table} WHERE "applicationId" = $1`, [applicationId]);
  await em.query(`DELETE FROM dispatcher_applications WHERE id = $1`, [applicationId]);
  await deleteInvitation(em, application.invitationId);
  return keys;
}
/** An invitation nobody used (or one whose application just went). Its activity stays, naming no invitation. */
export async function deleteInvitation(em: Q, invitationId: string): Promise<string[]> {
  await em.query(`DELETE FROM applicant_challenges WHERE "invitationId" = $1`, [invitationId]);
  await em.query(`DELETE FROM invitations WHERE id = $1`, [invitationId]);
  return [];
}
/** IT setup checklists (a new hire's or a support's), with what hangs off them. */
async function deleteSetups(em: Q, setupIds: string[]) {
  if (!setupIds.length) return;
  await em.query(`DELETE FROM portal_notifications WHERE "requestId" = ANY($1)`, [setupIds]);
  await em.query(`DELETE FROM it_onboarding_activity WHERE "requestId" = ANY($1)`, [setupIds]);
  await em.query(`DELETE FROM it_onboarding_tasks WHERE "requestId" = ANY($1)`, [setupIds]);
  await em.query(`DELETE FROM it_onboarding_requests WHERE id = ANY($1)`, [setupIds]);
}
/** IT checklists keyed by a member: removals, leave suspends and restores, and company account requests. */
async function deleteChecklists(em: Q, memberId: string) {
  for (const [table, notify] of [['it_removal_requests', 'removalId'], ['it_leave_requests', 'leaveRequestId'], ['it_account_requests', 'accountRequestId']] as const) {
    const requestIds = ids(await em.query(`SELECT id FROM ${table} WHERE "memberId" = $1`, [memberId]));
    if (!requestIds.length) continue;
    const prefix = table.replace(/_requests$/, '');
    await em.query(`DELETE FROM portal_notifications WHERE "${notify}" = ANY($1)`, [requestIds]);
    await em.query(`DELETE FROM ${prefix}_activity WHERE "requestId" = ANY($1)`, [requestIds]);
    await em.query(`DELETE FROM ${prefix}_tasks WHERE "requestId" = ANY($1)`, [requestIds]);
    await em.query(`DELETE FROM ${table} WHERE id = ANY($1)`, [requestIds]);
  }
}
/** A dispatcher, support or updater who left, with their application, catch-up paperwork, IT checklists and files. */
export async function deleteMember(em: Q, memberId: string): Promise<string[]> {
  const [member]: { applicationId: string | null }[] = await em.query(`SELECT "applicationId" FROM dispatch_members WHERE id = $1`, [memberId]);
  if (!member) return [];
  const photos: { id: string; kind: 'PROFILE' | 'ID' }[] = await em.query(`SELECT id, kind FROM member_photos WHERE "memberId" = $1`, [memberId]);
  const scans: { id: string; kind: string }[] = await em.query(`SELECT id, kind FROM member_paper_scans WHERE "memberId" = $1`, [memberId]);
  const keys = [...photos.map(photo => memberPhotoKey({ ...photo, memberId })), ...scans.map(scan => paperScanKey({ ...scan, memberId }))];
  await deleteChecklists(em, memberId);
  await deleteSetups(em, ids(await em.query(`SELECT id FROM it_onboarding_requests WHERE "memberId" = $1`, [memberId])));
  const leaves = ids(await em.query(`SELECT id FROM member_leaves WHERE "memberId" = $1`, [memberId]));
  if (leaves.length) await em.query(`DELETE FROM driver_leave_covers WHERE "leaveId" = ANY($1)`, [leaves]);
  for (const table of ['member_leaves', 'member_notices', 'team_lead_sign_ins', 'member_assignments', 'member_contacts', 'member_detail_corrections', 'member_photos', 'member_paper_scans'])
    await em.query(`DELETE FROM ${table} WHERE "memberId" = $1`, [memberId]);
  await em.query(`DELETE FROM promotion_requests WHERE "supportId" = $1`, [memberId]);
  // Their own support links, and other people's links to them: a link names exactly one dispatcher or team, so it can't outlive it.
  await em.query(`DELETE FROM member_support_links WHERE "supportId" = $1 OR "dispatcherId" = $1`, [memberId]);
  // Catch-up paperwork, accepted or not, belongs to this record.
  const catchUps: { id: string; applicationId: string | null }[] = await em.query(`SELECT i.id, a.id AS "applicationId" FROM invitations i LEFT JOIN dispatcher_applications a ON a."invitationId" = i.id WHERE i."catchUpMemberId" = $1`, [memberId]);
  // Their events stay, marked so they may name no member.
  await em.query(`UPDATE dispatch_events SET "memberId" = NULL, metadata = metadata || '{"recordDeleted": true}' WHERE "memberId" = $1`, [memberId]);
  await em.query(`UPDATE dispatch_members SET "applicationId" = NULL WHERE id = $1`, [memberId]);
  await em.query(`DELETE FROM dispatch_members WHERE id = $1`, [memberId]);
  const applications = new Set([...(member.applicationId ? [member.applicationId] : []), ...catchUps.flatMap(row => row.applicationId ? [row.applicationId] : [])]);
  for (const applicationId of applications) keys.push(...await deleteApplication(em, applicationId));
  for (const row of catchUps.filter(item => !item.applicationId)) await deleteInvitation(em, row.id);
  return keys;
}
/** A driver: their file, scans and reports, consent signatures, contracts, an owner-operator's trucks and their papers. */
export async function deleteDriver(em: Q, driverId: string): Promise<string[]> {
  const documents: { id: string; kind: string; storageLayout: StorageLayout; fromPaper: boolean }[] = await em.query(`SELECT id, kind, "storageLayout", "fromPaper" FROM driver_documents WHERE "driverId" = $1`, [driverId]);
  const reports: { id: string; kind: string; storageLayout: StorageLayout }[] = await em.query(`SELECT id, kind, "storageLayout" FROM driver_reports WHERE "driverId" = $1`, [driverId]);
  const ownerDocuments: { id: string; kind: string }[] = await em.query(`SELECT id, kind FROM driver_owner_documents WHERE "driverId" = $1`, [driverId]);
  const trucks = ids(await em.query(`SELECT id FROM driver_trucks WHERE "driverId" = $1`, [driverId]));
  const unitFiles: { id: string; kind: string; unitId: string }[] = trucks.length ? await em.query(`SELECT id, kind, "unitId" FROM unit_files WHERE "unitId" = ANY($1)`, [trucks]) : [];
  const copies: { storageKey: string }[] = await em.query(`SELECT "storageKey" FROM signed_copies WHERE "driverId" = $1`, [driverId]);
  const keys = [...documents.filter(doc => !doc.fromPaper).map(doc => driverDocumentKey({ ...doc, driverId })), ...reports.map(report => driverReportKey({ ...report, driverId })),
    ...ownerDocuments.map(doc => ownerDocumentKey({ ...doc, driverId })), ...unitFiles.map(file => unitFileKey(file)), ...copies.map(copy => copy.storageKey)];
  await em.query(`DELETE FROM driver_leave_covers WHERE "driverId" = $1`, [driverId]);
  await em.query(`DELETE FROM signed_copies WHERE "driverId" = $1`, [driverId]);
  await em.query(`DELETE FROM driver_consent_signatures WHERE "driverId" = $1`, [driverId]);
  await em.query(`UPDATE driver_links SET "contractId" = NULL WHERE "contractId" IN (SELECT id FROM driver_contracts WHERE "driverId" = $1)`, [driverId]);
  await em.query(`DELETE FROM driver_contracts WHERE "driverId" = $1`, [driverId]);
  if (trucks.length) {
    await em.query(`DELETE FROM unit_files WHERE "unitId" = ANY($1)`, [trucks]);
    await em.query(`DELETE FROM unit_permits WHERE "unitId" = ANY($1)`, [trucks]);
    await em.query(`DELETE FROM driver_owner_documents WHERE "truckId" = ANY($1)`, [trucks]);
  }
  // The rest of the file goes with the driver row (ON DELETE CASCADE); their events stay, naming no driver.
  await em.query(`DELETE FROM drivers WHERE id = $1`, [driverId]);
  return keys;
}

/** Every reference to the tables this file deletes from, as `child.column -> parent`. The job refuses to run when the database has others. */
export const KNOWN_REFERENCES = new Set([
  // dispatcher_applications and invitations
  'applicant_photos.applicationId', 'applicant_update_deliveries.applicationId', 'applicant_update_settings.applicationId', 'application_manager_changes.applicationId', 'application_reviews.applicationId',
  'application_submissions.applicationId', 'dispatch_members.applicationId', 'document_signatures.applicationId', 'document_views.applicationId', 'it_onboarding_requests.applicationId',
  'notification_deliveries.applicationId', 'signed_copies.applicationId', 'telegram_link_tokens.applicationId', 'applicant_update_deliveries.reviewId', 'it_onboarding_requests.approvalId',
  'applicant_challenges.invitationId', 'application_activity.invitationId', 'dispatcher_applications.invitationId',
  // dispatch_members and what hangs off them
  'dispatch_events.memberId', 'dispatch_members.previousMemberId', 'driver_assignments.memberId', 'driver_leave_covers.coverMemberId', 'existing_member_records.memberId', 'invitations.catchUpMemberId',
  'invitations.supportsMemberId', 'it_account_requests.memberId', 'it_leave_requests.memberId', 'it_onboarding_requests.memberId', 'it_removal_requests.memberId', 'member_assignments.memberId',
  'member_company_accounts.memberId', 'member_contacts.memberId', 'member_shared_accounts.memberId', 'member_shared_accounts.ownerMemberId', 'member_detail_corrections.memberId', 'member_leaves.memberId', 'member_load_board_seats.memberId', 'member_notices.memberId',
  'member_other_names.memberId', 'member_paper_documents.memberId', 'member_paper_scans.memberId', 'member_photos.memberId', 'member_start_date_changes.memberId', 'member_support_links.supportId',
  'member_support_links.dispatcherId', 'promotion_requests.supportId', 'team_lead_sign_ins.memberId', 'teams.leadMemberId', 'telegram_group_changes.addMemberId', 'telegram_group_changes.removeMemberId',
  'it_account_activity.requestId', 'it_account_tasks.requestId', 'portal_notifications.accountRequestId', 'it_leave_activity.requestId', 'it_leave_tasks.requestId', 'portal_notifications.leaveRequestId',
  'it_onboarding_activity.requestId', 'it_onboarding_tasks.requestId', 'it_removal_requests.setupRequestId', 'portal_notifications.requestId', 'promotion_requests.itRequestId',
  'it_removal_activity.requestId', 'it_removal_tasks.requestId', 'portal_notifications.removalId', 'it_account_requests.accountId', 'driver_leave_covers.leaveId', 'it_leave_requests.leaveId',
  // drivers and their trucks
  'driver_annual_reviews.driverId', 'driver_applications.driverId', 'driver_assignments.driverId', 'driver_clearance_items.driverId', 'driver_consent_signatures.driverId', 'driver_consent_views.driverId',
  'driver_contracts.driverId', 'driver_documents.driverId', 'driver_events.driverId', 'driver_incidents.driverId', 'driver_leave_covers.driverId', 'driver_links.driverId', 'driver_owner_documents.driverId',
  'driver_owners.driverId', 'driver_paper_items.driverId', 'driver_previous_employers.driverId', 'driver_reports.driverId', 'driver_reviews.driverId', 'driver_road_ready.driverId',
  'driver_road_ready_steps.driverId', 'driver_screening_checks.driverId', 'driver_telegram_link_tokens.driverId', 'driver_telegram_links.driverId', 'driver_tests.driverId', 'driver_trucks.driverId',
  'existing_driver_records.driverId', 'safety_reminders.driverId', 'signed_copies.driverId', 'telegram_group_changes.driverId', 'driver_leave_covers.coverAssignmentId', 'driver_links.contractId',
  'driver_challenges.linkId', 'driver_annual_reviews.reportId', 'driver_assignments.trailerId', 'driver_assignments.unitId', 'driver_contracts.unitId', 'driver_owner_documents.truckId',
  'driver_road_ready.unitId', 'owner_contract_files.unitId', 'telegram_group_changes.unitId', 'telegram_group_changes.newUnitId', 'unit_events.unitId', 'unit_files.unitId', 'unit_permits.unitId',
  'safety_reminder_deliveries.reminderId',
]);
/** The parents whose references KNOWN_REFERENCES must cover. */
export const DELETED_FROM = ['dispatcher_applications', 'invitations', 'application_reviews', 'dispatch_members', 'it_onboarding_requests', 'it_removal_requests', 'it_leave_requests', 'it_account_requests',
  'member_leaves', 'member_company_accounts', 'drivers', 'driver_assignments', 'driver_contracts', 'driver_links', 'driver_reports', 'driver_trucks', 'safety_reminders'];
