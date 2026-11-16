'use client';
import { Lock } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PrivateImage } from '@/components/ui/private-image';
import { PhotoButton, type ViewablePhoto } from '@/features/documents/photo-modal';

// Who this is (HandPhotosItScreen, section 33): the person's profile photo, and their ID photo on request (each view is recorded).
export function WhoThisIs({ memberId, name, photos }: { memberId: string; name: string; photos?: { profile: boolean; id: boolean } }) {
  if (!photos || (!photos.profile && !photos.id)) return null;
  const profile = `/api/backend/member-photos/${memberId}/profile`, id = `/api/backend/member-photos/${memberId}/id`;
  const list: ViewablePhoto[] = [...(photos.profile ? [{ src: profile, title: 'Profile photo', alt: `Profile photo of ${name}` }] : []),
    ...(photos.id ? [{ src: id, title: 'ID photo', meta: 'This view is recorded with your name.', alt: `ID photo of ${name}` }] : [])];
  return <Card><CardHeader title="Who this is" /><CardBody className="space-y-3">
    {photos.profile && <PhotoButton photos={list} src={profile} label={`Open the profile photo of ${name}`} className="w-40"><PrivateImage src={profile} alt={`Profile photo of ${name}`} className="aspect-[4/5] w-40 rounded-md border bg-muted object-cover" /></PhotoButton>}
    {photos.id && <div className="flex flex-wrap items-center justify-between gap-3"><span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground"><Lock aria-hidden="true" className="size-3.5" />ID photo, opens on request</span>
      <PhotoButton photos={list} src={id} label={`View the ID photo of ${name}`}><span className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent">View ID photo</span></PhotoButton></div>}
  </CardBody></Card>;
}
