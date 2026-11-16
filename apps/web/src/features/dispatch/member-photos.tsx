'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Camera, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/alert';
import { Checkbox, RadioGroup } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { PrivateImage } from '@/components/ui/private-image';
import { Timeline } from '@/components/ui/timeline';
import { useToast } from '@/components/ui/toast';
import { PhotoButton, type ViewablePhoto } from '@/features/documents/photo-modal';
import { photoForUpload } from '@/features/onboarding/photo';
import { errorMessage, mutate } from '@/lib/client-api';
import type { MemberProfile } from './types';

// Photos (Design System section 33, Photos for people added by hand, approved 2026-11-13): HandPhotosAdminScreen,
// HandPhotosManagerScreen, HandPhotoUploadScreen, HandIdPhotoViewerScreen.
export type PhotoKind = 'profile' | 'id';
/**
 * Their profile photo and ID photo. The ID photo stays closed until someone chooses View ID photo, since each view is recorded
 * with who opened it. For someone added by hand an administrator adds both; everyone else sees "Not added yet".
 */
export function MemberPhotosCard({ member, name, photos, profileUrl, idUrl, admin }: { member: MemberProfile; name: string; photos: ViewablePhoto[]; profileUrl: string; idUrl: string; admin: boolean }) {
  const [adding, setAdding] = useState<PhotoKind | null>(null);
  const hand = member.handPhotos ?? null, handAdded = !!member.existing && !member.applicationId;
  if (!member.photo && !member.idPhoto && !handAdded) return null;
  const canAdd = admin && handAdded;
  const added = (photo: { createdAt: string; uploadedBy: string | null } | null) => photo ? <>Added by {photo.uploadedBy ?? 'an administrator'} on <LocalTime iso={photo.createdAt} format="date" /></> : null;
  return <Card>
    <CardHeader title="Photos" description={handAdded ? `${member.firstName} started before the workspace. Administrators add these from a photo the company has or takes.` : 'As the applicant sent them. Open a photo to see it full size.'} />
    <CardBody className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-[repeat(auto-fill,minmax(220px,280px))]">
        <figure className="space-y-2">
          {member.photo ? <PhotoButton photos={photos} src={profileUrl} label={`Open the profile photo of ${name}`} className="w-full">
            <PrivateImage src={profileUrl} alt={`Profile photo of ${name}`} className="aspect-[4/5] w-full rounded-md border bg-muted object-cover" /></PhotoButton>
            : <div className="grid aspect-[4/5] w-full place-items-center rounded-md border border-dashed bg-muted text-sm text-muted-foreground">Not added yet</div>}
          <figcaption className="text-[13px] leading-5"><span className="font-medium">Profile photo</span><span className="block text-muted-foreground">{added(hand?.profile ?? null) ?? 'Shows on their page and the team chart.'}</span></figcaption>
          {canAdd && <Button variant="outline" onClick={() => setAdding('profile')}><Camera aria-hidden="true" className="size-4" />{member.photo ? 'Replace profile photo' : 'Add profile photo'}</Button>}
        </figure>
        <figure className="space-y-2">
          <div className="grid aspect-[4/5] w-full place-items-center gap-2 rounded-md border bg-muted p-4 text-center text-sm text-muted-foreground">
            <Lock aria-hidden="true" className="size-5" />{member.idPhoto ? 'Opens on request' : 'Not added yet'}
            {member.idPhoto && <PhotoButton photos={photos} src={idUrl} label={`View the ID photo of ${name}`} className="cursor-pointer">
              <span className="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent">View ID photo</span></PhotoButton>}
          </div>
          <figcaption className="text-[13px] leading-5"><span className="font-medium">ID photo</span><span className="block text-muted-foreground">{added(hand?.id ?? null) ?? 'Them holding their ID. Checked by eye only.'} Each view is recorded with who opened it.</span></figcaption>
          {canAdd && <Button variant="outline" onClick={() => setAdding('id')}><Camera aria-hidden="true" className="size-4" />{member.idPhoto ? 'Replace ID photo' : 'Add ID photo'}</Button>}
        </figure>
      </div>
      {!!hand?.idViews.length && <div><h3 className="mb-2 text-sm font-medium">Recent ID photo views</h3>
        <Timeline items={hand.idViews.map((view, index) => ({ id: String(index), title: 'ID photo viewed', meta: <>{view.viewedBy ?? 'Someone'} · <LocalTime iso={view.createdAt} format="date" /></> }))} /></div>}
    </CardBody>
    {adding && <AddPhotoDialog member={member} name={name} kind={adding} onClose={() => setAdding(null)} />}
  </Card>;
}

/** Add or replace a photo (HandPhotoUploadScreen): one JPEG, made smaller in the browser; its details are removed when saved. */
function AddPhotoDialog({ member, name, kind: first, onClose }: { member: MemberProfile; name: string; kind: PhotoKind; onClose: () => void }) {
  const router = useRouter(), toast = useToast();
  const [kind, setKind] = useState<PhotoKind>(first), [image, setImage] = useState<string | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    setError('');
    try { setImage(await photoForUpload(file)); } catch (failure) { setImage(null); setError(errorMessage(failure, 'Choose a photo (JPEG, or one the browser can read).')); }
  }
  async function save() {
    if (busy || !image) return;
    setBusy(true); setError('');
    try { await mutate(`dispatch/members/${member.id}/hand-photos/${kind}`, 'POST', { image, confirmed }); toast({ title: kind === 'profile' ? 'Profile photo saved' : 'ID photo saved' }); onClose(); router.refresh(); }
    catch (failure) { setError(errorMessage(failure, 'Unable to save the photo. Try again.')); }
    finally { setBusy(false); }
  }
  return <Dialog open onClose={onClose} busy={busy} title={`Add ${name}’s ${kind === 'profile' ? 'profile' : 'ID'} photo`} description="Only administrators add photos. Nobody is messaged."
    actions={<Button onClick={() => void save()} disabled={busy || !image || !confirmed}>{busy ? 'Saving…' : 'Save photo'}</Button>}>
    <div className="space-y-4">
      <RadioGroup name="kind" label="Which photo" value={kind} onChange={value => setKind(value as PhotoKind)} options={[{ value: 'profile', label: 'Profile photo', description: 'Their face, like an onboarding selfie.' }, { value: 'id', label: 'ID photo', description: 'Them holding their ID, like an onboarding selfie with ID.' }]} />
      <label className="block space-y-1"><span className="text-sm font-medium">Photo</span>
        <input type="file" accept="image/*" capture="environment" onChange={event => void choose(event)} className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5" />
        <span className="block text-[13px] text-muted-foreground">JPEG. A larger photo is made smaller first.</span></label>
      {/* A local preview of the chosen file, before it's sent. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {image && <img src={`data:image/jpeg;base64,${image}`} alt="The chosen photo" className="max-h-60 rounded-md border" />}
      <Checkbox label={`This is ${name}, and the photo shows their face clearly.`} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
      {kind === 'id' && <Notice message="Every staff member can open the ID photo on request, and each view is recorded. It never shows in lists or exports." />}
      <p className="text-[13px] leading-5 text-muted-foreground">Only these two photos. Never scans of an ID card alone, SSNs or other documents.</p>
      <Notice message={error} error />
    </div>
  </Dialog>;
}
