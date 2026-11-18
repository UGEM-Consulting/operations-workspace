'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { Alert, Notice } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/field';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/workspace-ui';
import { errorMessage, mutate } from '@/lib/client-api';
import { deliveryBadge, failureReason, TelegramPreview, type AnnouncementDetail } from './shared';

/** One announcement (AnnounceDetailScreen, AnnounceTakeBackScreen): the message, each group's delivery, and Take back for 48 hours. */
export function AnnouncementPage({ announcement }: { announcement: AnnouncementDetail }) {
  const router = useRouter(), toast = useToast();
  const [taking, setTaking] = useState(false), [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const failed = announcement.deliveries.filter(delivery => delivery.status === 'FAILED');
  const retrying = announcement.deliveries.filter(delivery => delivery.status === 'SENT' && delivery.retrying);
  const stuck = announcement.deliveries.filter(delivery => delivery.status === 'SENT' && !delivery.retrying && delivery.failureCode?.startsWith('DELETE_'));
  // Sending and deleting go on in the background once the request's time is up: refresh until nothing is on its way.
  const working = retrying.length > 0 || announcement.deliveries.some(delivery => delivery.status === 'PENDING' || delivery.status === 'SENDING');
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [working, router]);
  const teams = announcement.deliveries.length === 1 ? '1 team' : `${announcement.deliveries.length} teams`;
  async function takeBack() {
    setBusy(true); setError('');
    try {
      await mutate(`announcements/${announcement.id}/take-back`, 'POST', reason.trim() ? { reason: reason.trim() } : {});
      setTaking(false); toast({ title: 'Announcement taken back' }); router.refresh();
    } catch (failure) { setError(errorMessage(failure, 'It wasn’t taken back. Try again.')); }
    finally { setBusy(false); }
  }
  return <div className="space-y-6">
    <PageHeader title="Announcement" meta={[<>Sent <LocalTime iso={announcement.createdAt} /> by {announcement.authorName}</>, teams]}
      action={announcement.canTakeBack ? <Button variant="outline" onClick={() => { setReason(''); setError(''); setTaking(true); }}><Undo2 aria-hidden="true" className="size-4" />Take back</Button> : undefined} />
    {announcement.takenBackAt && <Alert tone="info" title="Taken back">
      <p>Taken back <LocalTime iso={announcement.takenBackAt} />{announcement.takenBackBy ? ` by ${announcement.takenBackBy}` : ''}. {retrying.length ? 'The bot is deleting it from the groups that had it.' : stuck.length ? 'The bot deleted it where Telegram allowed it.' : 'The bot deleted it from the groups that had it.'}{announcement.takeBackReason ? ` Why: ${announcement.takeBackReason}` : ''}</p></Alert>}
    {failed.map(delivery => <Alert key={delivery.id} tone="warning" title={`${delivery.team}’s group didn’t get it`}>
      <p>{delivery.failureCode === 'FORBIDDEN' ? 'The bot was removed from that group. An administrator can link it again on Admin › Telegram; then send a new announcement to that team.'
        : delivery.failureCode === 'UNCONFIRMED' ? 'Telegram didn’t confirm it, so it wasn’t sent again. Check the group: it may be there, and the workspace can’t take that copy back.' : `Not delivered: ${failureReason(delivery.failureCode)}. Send a new announcement to that team if it still matters.`}</p></Alert>)}
    {stuck.length > 0 && <Alert tone="warning" title="Still in some groups"><p>{stuck.map(delivery => delivery.team).join(', ')}: Telegram didn’t delete it there. Ask someone in that group to delete the message.</p></Alert>}
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-6">
        <Card><CardHeader title="Message" /><CardBody><p className="text-sm leading-6 whitespace-pre-line break-words">{announcement.text}</p></CardBody></Card>
        <Card><CardHeader title="Groups" />
          <Table className="mt-3 border-t border-border" caption="Delivery by group" rows={announcement.deliveries} rowKey={row => row.id} columns={[
            { key: 'team', label: 'Team', primary: true, cell: row => <span className="font-medium">{row.team}</span> },
            { key: 'group', label: 'Telegram group', cell: row => row.groupTitle ?? 'Telegram group' },
            { key: 'delivered', label: 'Delivered', cell: row => { const badge = deliveryBadge(row); return <span className="inline-flex flex-wrap items-center gap-2"><Badge label={badge.label} tone={badge.tone} />{row.status === 'SENT' && row.sentAt && <LocalTime iso={row.sentAt} className="text-[13px] text-muted-foreground" />}</span>; } },
          ]} />
        </Card>
      </div>
      <div className="min-w-0 lg:sticky lg:top-4 lg:self-start"><TelegramPreview chat={announcement.deliveries[0]?.groupTitle ?? announcement.deliveries[0]?.team ?? 'Team group'} from={`${announcement.authorName}, ${announcement.authorRole}`} text={announcement.text} time={<LocalTime iso={announcement.createdAt} format="time" />} /></div>
    </div>
    <Dialog open={taking} onClose={() => setTaking(false)} title="Take back this announcement?" tone="danger" busy={busy}
      description={`The bot deletes it from the groups that got it. People who already read it may have seen it.`}
      closeLabel="Keep it" actions={<Button variant="destructive" onClick={() => void takeBack()} disabled={busy}><Undo2 aria-hidden="true" className="size-4" />{busy ? 'Taking back…' : 'Take back'}</Button>}>
      <Textarea label="Why" optional rows={2} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} hint="Kept here for staff. Not sent to the groups." />
      <Notice message={error} error />
    </Dialog>
  </div>;
}
