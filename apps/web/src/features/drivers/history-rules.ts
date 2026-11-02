/**
 * The driver's address and work history rules, mirrored from apps/api/src/modules/safety/history-rules.ts for guidance on the
 * page only: what to show as covered, which gaps to explain and what is still needed. The API decides at submission.
 */
export type YesNo = 'YES' | 'NO';
export type YesNoUnsure = YesNo | 'UNSURE';
export interface HistoryAddress { id: string; line1: string; city: string; state: string; zip: string; fromMonth: string; toMonth: string }
export interface HistoryJob { id: string; company: string; city: string; state: string; phone: string; position: string; fromMonth: string; toMonth: string | null;
 drove: YesNo; fmcsr: YesNoUnsure; dotTesting: YesNoUnsure; reasonLeft: string }
export interface HistoryGap { from: string; to: string; explanation: string }
export interface HistoryAccident { id: string; month: string; state: string; description: string }
export interface HistoryTicket { id: string; month: string; state: string; violation: string; vehicle: 'CMV' | 'OTHER' }
export interface HistoryLicense { id: string; state: string; number: string; licenseClass: string }
export interface DriverHistory {
 currentSince?: string; addresses?: HistoryAddress[]; jobs?: HistoryJob[]; gaps?: HistoryGap[]; noEarlierDriving?: boolean;
 accidents?: YesNo; accidentList?: HistoryAccident[]; tickets?: YesNo; ticketList?: HistoryTicket[];
 otherLicenses?: YesNo; licenseList?: HistoryLicense[]; licenseTrouble?: YesNo; licenseTroubleNote?: string;
}
export const HISTORY_YEARS = 3, DRIVING_YEARS = 10;

/** Months as a number (year × 12 + month index) and back. */
const index = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const month = (value: number) => `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, '0')}`;
export const addMonths = (value: string, months: number) => month(index(value) + months);

/** The runs of months from `start` to `end` that none of the periods covers. */
function uncovered(periods: { from: string; to: string }[], start: string, end: string): { from: string; to: string }[] {
 const runs: { from: string; to: string }[] = [];
 for (let at = index(start), open = -1; at <= index(end) + 1; at++) {
  const covered = at > index(end) || periods.some(period => index(period.from) <= at && at <= index(period.to));
  if (!covered && open < 0) open = at;
  if (covered && open >= 0) { runs.push({ from: month(open), to: month(at - 1) }); open = -1; }
 }
 return runs;
}
/** The gaps in the last 3 years with no job, each of which the driver explains. */
export function jobGaps(history: DriverHistory, now: string) {
 const jobs = (history.jobs ?? []).map(job => ({ from: job.fromMonth, to: job.toMonth ?? now }));
 return uncovered(jobs, addMonths(now, -HISTORY_YEARS * 12 + 1), now);
}
/** Whether the addresses (the current one since `currentSince`, then the previous ones) cover the last 3 years. */
export function addressesCovered(history: DriverHistory, now: string) {
 if (!history.currentSince) return false;
 const periods = [{ from: history.currentSince, to: now }, ...(history.addresses ?? []).map(address => ({ from: address.fromMonth, to: address.toMonth }))];
 return uncovered(periods, addMonths(now, -HISTORY_YEARS * 12 + 1), now).length === 0;
}
/** The oldest month the jobs reach, and whether that is far enough back for commercial driving (or the driver confirmed). */
export function drivingCovered(history: DriverHistory, now: string) {
 const oldest = (history.jobs ?? []).map(job => job.fromMonth).sort()[0];
 return history.noEarlierDriving === true || (!!oldest && oldest <= addMonths(now, -DRIVING_YEARS * 12 + 1));
}

/**
 * What the history still needs before the application can be sent, as codes the web turns into words: history:currentSince,
 * history:addresses, history:dates (a period that ends before it starts or is in the future), history:gap:<from>_<to> (an
 * unexplained gap), history:driving, history:accidents, history:tickets, history:licenses and history:licenseTrouble.
 */
export function historyMissing(history: DriverHistory | null | undefined, now: string): string[] {
 const value = history ?? {}, missing: string[] = [];
 const periods = [...(value.addresses ?? []).map(row => [row.fromMonth, row.toMonth]), ...(value.jobs ?? []).map(row => [row.fromMonth, row.toMonth ?? now])];
 if (periods.some(([from, to]) => from > to || to > now) || (value.currentSince ?? '') > now) missing.push('history:dates');
 if (!value.currentSince) missing.push('history:currentSince');
 else if (!addressesCovered(value, now)) missing.push('history:addresses');
 const explained = new Map((value.gaps ?? []).map(gap => [`${gap.from}_${gap.to}`, gap.explanation.trim()]));
 missing.push(...jobGaps(value, now).filter(gap => !explained.get(`${gap.from}_${gap.to}`)).map(gap => `history:gap:${gap.from}_${gap.to}`));
 if (!drivingCovered(value, now)) missing.push('history:driving');
 if (!value.accidents || (value.accidents === 'YES' && !value.accidentList?.length)) missing.push('history:accidents');
 if (!value.tickets || (value.tickets === 'YES' && !value.ticketList?.length)) missing.push('history:tickets');
 if (!value.otherLicenses || (value.otherLicenses === 'YES' && !value.licenseList?.length)) missing.push('history:licenses');
 if (!value.licenseTrouble || (value.licenseTrouble === 'YES' && !value.licenseTroubleNote?.trim())) missing.push('history:licenseTrouble');
 return missing;
}

