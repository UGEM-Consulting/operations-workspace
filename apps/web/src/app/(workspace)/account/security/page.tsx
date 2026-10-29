import { apiRequest, requirePage } from '@/lib/auth';
import { mfaStatusSchema, readResponse, savedSignatureSchema, staffTelegramSchema } from '@/lib/api-schemas';
import { TelegramAlerts, type StaffTelegram } from '@/features/auth/telegram-alerts';
import { PageHeader } from '@/components/workspace-ui';
import { AccountSecurity, PasswordSettings, type MfaStatus } from '@/features/auth/account-security';
import { SavedSignatureSettings, type SavedSignature } from '@/features/auth/saved-signature';
export const metadata = { title: 'Account security' };
// Managers and administrators countersign NDAs during approval, so they can keep a saved signature.
const APPROVERS = ['SYSTEM_ADMIN', 'DISPATCHER_MANAGER'];
export default async function AccountSecurityPage() {
  const identity = await requirePage('security');
  const approver = APPROVERS.includes(identity.user.role);
  const [response, signatureResponse, telegramResponse] = await Promise.all([apiRequest('auth/mfa'), approver ? apiRequest('staff/signature') : null, apiRequest('staff/telegram')]);
  if (!response.ok || (signatureResponse && !signatureResponse.ok)) throw new Error('Unable to load account security');
  const status = await readResponse<MfaStatus>(response, 'MFA status', mfaStatusSchema);
  const signature = signatureResponse ? await readResponse<{ saved: SavedSignature | null }>(signatureResponse, 'saved signature', savedSignatureSchema) : null;
  // An API older than staff alerts has no such route; the card is then left out.
  const telegram = telegramResponse.ok ? await readResponse<StaffTelegram>(telegramResponse, 'Telegram alerts', staffTelegramSchema) : null;
  return <div className="space-y-6"><PageHeader eyebrow="Your account" title="Account security" description="How you sign in to the workspace, and your saved signature for approvals." />
    <div className="grid max-w-3xl gap-6"><PasswordSettings account={identity.user.email} /><AccountSecurity status={status} />{telegram && <TelegramAlerts initial={telegram} />}{signature && <SavedSignatureSettings initial={signature.saved} />}</div></div>;
}
