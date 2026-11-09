'use client';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { Timeline } from '@/components/ui/timeline';
import { reminderKinds, reminderOutcome, reminderStep } from './reminder-words';
import type { DriverProfile } from './types';

/**
 * The driver's expiration reminders (designed as ReminderDriverProfileScreen): whether they reach Telegram or email, what
 * was sent, and, while they aren't on Telegram, the one-time link Safety can send them (ReminderDriverLinkScreen).
 */
export function RemindersCard({ driver, onLink, pending }: { driver: DriverProfile; onLink?: () => void; pending?: boolean }) {
  const reminders = driver.reminders!;
  return <Card>
    <CardHeader title="Reminders" />
    <CardBody className="space-y-4">
      <DescriptionList layout="rows" items={[
        { label: 'Telegram', value: reminders.telegramConnected ? <Badge label="Connected" tone="success" /> : <Badge label="Not connected" tone="neutral" /> }]} />
      {/* Full width, so a long address fits the narrow rail. */}
      <p className="text-sm">{driver.email ? <>{reminders.telegramConnected ? 'If Telegram stops working, by email to ' : 'By email to '}<span className="break-all">{driver.email}</span></> : 'No email on file: add one to send reminders.'}</p>
      {reminders.items.length > 0 ? <Timeline items={reminders.items.slice(0, 5).map((row, index) => ({ id: `${row.kind}-${row.dueOn}-${row.step}-${index}`,
        title: `${reminderKinds[row.kind] ?? 'Document'}, ${reminderStep(row.step)}`,
        meta: <>{reminderOutcome(row)} · <LocalTime iso={row.sentAt ?? row.createdAt} format="date" /></> }))} />
        : <p className="text-[13px] text-muted-foreground">Their license and medical card are reminded about 30 and 7 days before they expire, and on the day.</p>}
      {onLink && !reminders.telegramConnected && reminders.telegramAvailable && <Button variant="outline" className="w-full" disabled={pending} onClick={onLink}>
        <Send aria-hidden="true" className="size-4" />{pending ? 'Preparing…' : 'Telegram link for reminders'}</Button>}
    </CardBody>
  </Card>;
}
