'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ellipsis, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
import { Alert, Notice } from '@/components/ui/alert';
import { Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { errorMessage, mutate } from '@/lib/client-api';

export interface ManagerOption { id: string; firstName: string; lastName: string; role: string }
const roleLabel = (role: string) => role === 'SYSTEM_ADMIN' ? 'Administrator' : 'Dispatch manager';

/**
 * More actions on an application (designed as ChangeManagerScreen): hand it to another responsible manager. The new
 * manager reviews, decides and gets the IT setup notice; the applicant isn't told. A manager who hands it over no longer
 * sees it, so they leave for the applications list; an administrator stays.
 */
export function ChangeManager({ id, current, options, admin }: { id: string; current: string; options: ManagerOption[]; admin: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false), [managerId, setManagerId] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState('');
  const chosen = options.find(option => option.id === managerId);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!managerId) { setError('Choose the new responsible manager.'); return; }
    const note = String(new FormData(event.currentTarget).get('note') ?? '').trim();
    setPending(true); setError('');
    try {
      await mutate(`onboarding/applications/${id}/manager`, 'POST', { managerId, ...(note ? { note } : {}) });
      setOpen(false);
      toast({ title: 'Responsible manager changed', description: `${chosen?.firstName} ${chosen?.lastName} is responsible for this application now.` });
      if (admin) router.refresh(); else router.push('/onboarding/applications');
    } catch (error) { setError(errorMessage(error, 'Unable to change the manager. Your entries have been kept.')); }
    finally { setPending(false); }
  }
  return <>
    <DropdownMenu label="More actions" triggerIcon={Ellipsis} align="end" items={[{ label: 'Change responsible manager', icon: UserCheck, onSelect: () => { setOpen(true); setManagerId(''); setError(''); } }]} />
    {open && <Dialog open onClose={() => setOpen(false)} busy={pending} title="Change responsible manager"
      description="The responsible manager reviews this application, decides on it and gets the notice when IT finishes setup."
      actions={<Button type="submit" form="change-manager">{pending ? 'Changing…' : 'Change manager'}</Button>}>
      <form id="change-manager" onSubmit={submit} className="space-y-4">
        <Select id="new-manager" label="New responsible manager" name="managerId" value={managerId} onChange={event => setManagerId(event.target.value)} placeholder="Choose a manager" width="full"
          hint={`Now: ${current}. Active dispatch managers and administrators.`} options={options.map(option => ({ value: option.id, label: `${option.firstName} ${option.lastName} · ${roleLabel(option.role)}` }))} />
        <Textarea id="manager-note" label={chosen ? `Note for ${chosen.firstName}` : 'Note for the new manager'} name="note" optional rows={2} maxLength={500} hint="Shown on the application’s history. The applicant never sees it." />
        {!admin && <Alert tone="warning"><p>You’ll no longer see this application. The applicant isn’t told; their link and draft don’t change.</p></Alert>}
        <Notice message={error} error />
      </form>
    </Dialog>}
  </>;
}
