'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DescriptionList } from '@/components/ui/description-list';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/alert';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';
import { PasswordReadyDialog, type ReadyPassword } from '@/features/users/password-ready-dialog';

export interface SignInTask { id: string; signIn: 'CREATE' | 'TURN_ON' | 'TURN_OFF'; name: string; email: string | null; team: string | null; mc: string | null }
const LABELS = { CREATE: 'Create sign-in', TURN_ON: 'Turn back on', TURN_OFF: 'Turn off' } as const;

/**
 * A team lead's sign-in in IT tasks: one button that opens the step (designed as TeamLeadCreateScreen, TeamLeadNoEmailScreen,
 * TeamLeadEmailProblemScreen, TeamLeadTurnBackOnScreen and TeamLeadTurnOffScreen). Everything comes from their record, so
 * there's nothing to pick; with no company email recorded IT adds it here. The first password is shown once afterwards.
 */
export function SignInTaskButton({ task }: { task: SignInTask }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [ready, setReady] = useState<ReadyPassword | null>(null);
  const first = task.name.split(' ')[0];
  async function confirm() {
    if (pending) return;
    setPending(true); setError('');
    try {
      const result = await mutate<{ email: string; name: string; generatedPassword?: string }>(`it/sign-ins/${task.id}`, 'POST', task.email ? {} : { companyEmail: email });
      setOpen(false);
      if (result.generatedPassword) setReady({ kind: 'created', name: result.name, firstName: first, email: result.email, password: result.generatedPassword, emailLabel: 'Company email',
        title: task.signIn === 'CREATE' ? `Sign-in created for ${result.name}` : `Sign-in turned back on for ${result.name}` });
      else { toast({ title: `${first}’s sign-in is off` }); router.refresh(); }
    } catch (error) { setError(errorMessage(error, 'Not done. Reload IT tasks and try again.')); }
    finally { setPending(false); }
  }
  const team = task.team ? `${task.team}${task.mc ? ` · ${task.mc}` : ''}` : 'No team';
  const who = [{ label: 'Dispatcher', value: task.name }, { label: 'Team', value: team }, { label: 'Role', value: 'Team lead' }];
  return <>
    <Button size="sm" variant="outline" onClick={() => { setOpen(true); setError(''); }}>{LABELS[task.signIn]}<span className="sr-only"> for {task.name}</span></Button>
    {open && task.signIn === 'TURN_OFF' && <Dialog open onClose={() => setOpen(false)} busy={pending} size="sm" tone="danger" title={`Turn off ${task.name}’s sign-in?`}
      description={`${first} no longer leads a team. They’ll be signed out everywhere and won’t be able to sign in. Their dispatcher record doesn’t change.`}
      actions={<Button variant="destructive" onClick={() => void confirm()}>{pending ? 'Turning off…' : 'Turn off sign-in'}</Button>}>
      <Notice message={error} error />
    </Dialog>}
    {open && task.signIn !== 'TURN_OFF' && <Dialog open onClose={() => setOpen(false)} busy={pending}
      title={task.signIn === 'CREATE' ? `Create sign-in for ${task.name}` : `Turn on ${task.name}’s sign-in`}
      description={task.signIn === 'TURN_ON' ? `${first} leads a team again, so their old account comes back with a new first password.` : task.email ? 'They’ll see only their team.' : 'Add their company email first. It’s what they’ll sign in with.'}
      actions={<Button onClick={() => void confirm()} disabled={!task.email && !email.trim()}><KeyRound aria-hidden="true" className="size-4" />{pending ? 'Saving…' : task.signIn === 'CREATE' ? 'Create sign-in' : 'Turn back on'}</Button>}>
      <div className="space-y-4">
        <DescriptionList layout="rows" items={task.email ? [...who, { label: 'Company email', value: task.email }] : who} />
        {!task.email && <Input label="Company email" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="off" width="full" error={error || undefined} hint="This is also saved on their dispatcher record." />}
        {task.signIn === 'CREATE' && task.email && <p className="text-[13px] leading-5 text-muted-foreground">We’ll create a first password for you to send them. They replace it with their own when they first sign in. To use a different email, correct it on their dispatcher record first.</p>}
        {task.email && <Notice message={error} error />}
      </div>
    </Dialog>}
    {ready && <PasswordReadyDialog ready={ready} onClose={() => { setReady(null); router.refresh(); }} />}
  </>;
}
