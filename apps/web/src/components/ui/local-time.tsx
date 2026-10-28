'use client';
import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const formats = {
  datetime: { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' },
  date: { year: 'numeric', month: 'short', day: 'numeric' },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

/**
 * A timestamp in the viewer's own time zone. The server and first client render show a stable UTC value, then the
 * browser's locale and zone replace it after mount, so server-rendered pages never show the server's zone or mismatch.
 */
export function LocalTime({ iso, format = 'datetime', fallback = '—', className }: { iso: string | null | undefined; format?: keyof typeof formats; fallback?: string; className?: string }) {
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return <span className={className}>{fallback}</span>;
  const options: Intl.DateTimeFormatOptions = mounted ? formats[format] : { ...formats[format], timeZone: 'UTC', ...(format === 'date' ? {} : { timeZoneName: 'short' }) };
  const text = new Intl.DateTimeFormat(mounted ? undefined : 'en-US', options).format(date);
  const full = mounted && format === 'date' ? new Intl.DateTimeFormat(undefined, formats.datetime).format(date) : undefined;
  return <time dateTime={date.toISOString()} title={full} className={className}>{text}</time>;
}
