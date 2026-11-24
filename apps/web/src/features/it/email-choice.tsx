'use client';
import { Alert } from '@/components/ui/alert';
import { Checkbox, RadioGroup } from '@/components/ui/field';
import { EMAIL_ACTION_OPTIONS, type EmailAction, type EmailChoice } from './email-words';

/** The manager's choice: what happens to the email after the last day, and whether new email comes to them for 30 days. */
export function EmailAfterFields({ email, value, onChange, label = 'Their company email after the last day', forwarding = true }: { email: string; value: EmailChoice; onChange: (value: EmailChoice) => void; label?: string;
  /** A move closes the old email with no forwarding. */ forwarding?: boolean }) {
  return <div className="grid gap-3">
    <RadioGroup name="emailAction" label={label} cards value={value.action} onChange={action => onChange({ action: action as EmailAction, forward: action === 'DELETE' ? false : value.forward })} options={EMAIL_ACTION_OPTIONS} />
    {value.action === 'DELETE' && <Alert tone="warning" title="Their email and Drive files go too"><p>After 20 days nobody can get them back. Save what you need first, or choose Archive.</p></Alert>}
    {/* A deleted account can't forward new email, so forwarding is offered only to archive or suspend. */}
    {forwarding && value.action !== 'DELETE' && <Checkbox name="forward" label="Forward new email to me for 30 days" checked={value.forward} onChange={event => onChange({ ...value, forward: event.target.checked })} description={`IT sends anything new for ${email} to you.`} />}
  </div>;
}
