"use client";
import { useCallback, useState } from 'react';
import { Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/status-badge';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Input } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { errorMessage, mutate } from '@/lib/client-api';
import { SignaturePad, type SignatureMethod } from '@/features/onboarding/signature-pad';
export interface SavedSignature { typedName: string; signatureMethod: SignatureMethod; updatedAt: string; image: string }
export const ADOPT_STATEMENT = 'I adopt this as my electronic signature. Each time I choose to countersign a document with it, it is my legally binding signature on that document.';

/** A manager's or administrator's saved countersigning signature: set up once, then applied during approvals. */
export function SavedSignatureSettings({ initial }: { initial: SavedSignature | null }) {
  const [saved, setSaved] = useState(initial);
  const [editing, setEditing] = useState(!initial);
  const [name, setName] = useState(initial?.typedName ?? '');
  const [signature, setSignature] = useState<{ image: string; method: SignatureMethod } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean }>({ message: '', error: false });
  const onSignature = useCallback((image: string | null, method: SignatureMethod) => setSignature(image ? { image, method } : null), []);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setNotice({ message: '', error: false });
    if (!signature) { setNotice({ message: 'Draw your signature, or type your name and adopt it.', error: true }); return; }
    setPending(true);
    try {
      const result = await mutate<{ saved: SavedSignature }>('staff/signature', 'POST', { typedName: name, signature: signature.image, signatureMethod: signature.method, agreed: new FormData(event.currentTarget).get('agreed') === 'on' });
      setSaved(result.saved); setEditing(false); setSignature(null);
      setNotice({ message: 'Signature saved. You can use it when you countersign during approval.', error: false });
    } catch (error) { setNotice({ message: errorMessage(error, 'Unable to save your signature.'), error: true }); }
    finally { setPending(false); }
  }
  async function remove() {
    setPending(true);
    try { await mutate('staff/signature/delete', 'POST'); setSaved(null); setEditing(true); setRemoving(false); setNotice({ message: 'Saved signature removed.', error: false }); }
    catch (error) { setRemoving(false); setNotice({ message: errorMessage(error, 'Unable to remove your signature.'), error: true }); }
    finally { setPending(false); }
  }
  return <Card>
    <CardHeader title="Saved signature" description="Apply it when you countersign an NDA during approval. You still confirm each document. Only you can see it, and changing it never alters documents you already signed."
      actions={<Badge label={saved ? 'Saved' : 'Not saved'} tone={saved ? 'success' : 'neutral'} />} />
    <CardBody className="space-y-5">
    {saved && !editing && <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        {/* The ink is dark on a transparent background, so the preview keeps a light surface in both themes. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- server-provided data URL */}
        <img src={saved.image} alt={`Your saved signature for ${saved.typedName}`} className="h-20 w-auto max-w-full rounded-md border border-border bg-white p-2" />
        <div className="text-sm"><p>Signs as <span className="font-medium">{saved.typedName}</span></p><p className="text-[13px] leading-5 text-muted-foreground">{saved.signatureMethod === 'TYPED' ? 'Adopted from your typed name' : 'Drawn'} · saved <LocalTime iso={saved.updatedAt} /></p></div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" onClick={() => { setEditing(true); setNotice({ message: '', error: false }); }}>Replace signature</Button>
        <Button variant="outline" className="text-danger" onClick={() => setRemoving(true)}>Remove</Button>
      </div>
    </div>}
    {editing && <form onSubmit={save} className="space-y-4">
      <Input label="Your full legal name" hint="Latin letters, as on your ID." name="typedName" value={name} onChange={event => setName(event.target.value)} required maxLength={100} pattern="[A-Za-z][A-Za-z .,'\-]+" autoComplete="name" width="md" />
      <SignaturePad label="Your signature" onChange={onSignature} disabled={pending} allowTyped typedName={name} />
      <Checkbox name="agreed" required label={ADOPT_STATEMENT} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save signature'}</Button>
        {saved && <Button type="button" variant="outline" disabled={pending} onClick={() => setEditing(false)}>Cancel</Button>}
      </div>
    </form>}
    <Notice message={notice.message} error={notice.error} />
    </CardBody>
    {removing && <Dialog open onClose={() => setRemoving(false)} busy={pending} tone="danger" title="Remove saved signature?" description="You can still sign during each approval, or save a new signature later. Documents you already signed keep their signatures."
      actions={<Button variant="destructive" onClick={() => void remove()} disabled={pending}>{pending ? 'Removing…' : 'Remove signature'}</Button>}><span className="sr-only">Confirm removal</span></Dialog>}
  </Card>;
}
