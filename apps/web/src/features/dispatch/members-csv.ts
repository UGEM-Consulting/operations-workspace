import { csvCell } from './existing-csv.ts';
import type { MemberRow } from './types.ts';

/** A row of the Dispatchers export: the list's work details plus RingCentral and Telegram. Never personal contacts. */
export type ExportRow = MemberRow & { ringCentralNumber?: string | null; ringCentralExtension?: string | null; telegram?: string | null };
export const EXPORT_COLUMNS = ['Name', 'Position', 'MC', 'Team', 'Team lead', 'Job title', 'Since', 'Status', 'Last day', 'Company email', 'RingCentral number', 'Extension', 'Telegram'];
const STATUS: Record<string, string> = { ONBOARDING: 'Onboarding', ACTIVE: 'Active', LEFT: 'Left' };
const positionName = (row: MemberRow) => row.position === 'DISPATCHER' ? 'Dispatcher' : row.supportType === 'UPDATER' ? 'Updater' : 'Support';
const statusName = (row: MemberRow) => row.lastDay && row.status !== 'LEFT' ? 'Leaving' : row.leave?.started ? 'On leave' : STATUS[row.status] ?? row.status;
/** A Telegram username as @name, however it was typed: an application keeps the answer as written (@name, name or a t.me link). */
export function telegramHandle(value: string | null | undefined) {
  const name = (value ?? '').trim().replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, '').replace(/^@+/, '').replace(/\/+$/, '');
  return name ? `@${name}` : '';
}
/** The day as the page shows it (LocalTime, in this browser's time zone), not the UTC date of the moment. */
const localDay = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
/** The CSV a manager downloads; cells a spreadsheet would run as a formula are escaped. */
export function membersCsv(rows: ExportRow[]) {
  const line = (cells: (string | null | undefined)[]) => cells.map(value => csvCell(value ?? '')).join(',');
  return [line(EXPORT_COLUMNS), ...rows.map(row => line([`${row.firstName} ${row.lastName}`.trim(), positionName(row), row.mc, row.team, row.teamLead, row.position === 'SUPPORT' ? '' : row.jobTitle,
    row.sinceKnown === false || !row.since ? '' : localDay(row.since), statusName(row), row.lastDay, row.companyEmail, row.ringCentralNumber, row.ringCentralExtension, telegramHandle(row.telegram)]))].join('\r\n') + '\r\n';
}
