import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DescriptionList } from '@/components/ui/description-list';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { Table } from '@/components/ui/table';
import { jobGaps, type DriverHistory, type HistoryJob } from '@/features/drivers/history-rules';
import { monthLabel } from '@/features/drivers/history-section';
import { licenseTypes } from './types';

const span = (from: string, to: string | null) => from === to ? monthLabel(from) : `${monthLabel(from)} – ${to ? monthLabel(to) : 'now'}`;
const answer = (value: string | undefined, yes: string) => value === 'YES' ? yes : value === 'NO' ? 'None' : 'Not answered';
type Row = { kind: 'job'; job: HistoryJob } | { kind: 'gap'; from: string; to: string; explanation: string };

/**
 * The driver's address and work history as sent with their application (DriverHistoryReviewScreen): addresses for 3 years,
 * jobs with the federal driving answers and each gap with the driver's explanation, then accidents, tickets and licenses.
 * Every Safety role reads it; the Safety lead records the Address and work history check in screening. `sentOn` is when
 * the application was submitted; gaps are worked out as of that month. `currentAddress` is the home address from the application.
 */
export function HistoryReview({ history, sentOn, currentAddress }: { history: DriverHistory; sentOn: string | null; currentAddress: string }) {
  const asOf = (sentOn ?? new Date().toISOString()).slice(0, 7);
  const explained = (from: string, to: string) => history.gaps?.find(gap => gap.from === from && gap.to === to)?.explanation ?? '';
  const rows: Row[] = [...(history.jobs ?? []).map(job => ({ kind: 'job' as const, job })), ...jobGaps(history, asOf).map(gap => ({ kind: 'gap' as const, ...gap, explanation: explained(gap.from, gap.to) }))]
    .sort((a, b) => (b.kind === 'gap' ? b.to : b.job.toMonth ?? '9999').localeCompare(a.kind === 'gap' ? a.to : a.job.toMonth ?? '9999'));
  const addresses = [{ id: 'current', label: currentAddress || 'Current address', from: history.currentSince ?? '', to: null as string | null },
    ...(history.addresses ?? []).map(address => ({ id: address.id, label: `${address.line1}, ${address.city}, ${address.state} ${address.zip}`, from: address.fromMonth, to: address.toMonth as string | null }))]
    .filter(row => row.from);
  return <Card>
    <CardHeader title="Address and work history" description={<>From the driver’s application{sentOn ? <>, sent <LocalTime iso={sentOn} format="date" /></> : ''}. Check it against the MVR and the employers’ answers.</>} />
    <CardBody className="space-y-6">
      <section className="space-y-2"><h3 className="text-sm font-medium">Addresses (3 years)</h3>
        <Table caption="Addresses" rows={addresses} rowKey={row => row.id} columns={[{ key: 'a', label: 'Address', primary: true, cell: row => row.label },
          { key: 'd', label: 'Dates', muted: true, nowrap: true, cell: row => span(row.from, row.to) }]} empty={<p className="text-sm text-muted-foreground">No addresses given.</p>} /></section>
      <section className="space-y-2"><h3 className="text-sm font-medium">Jobs (3 years, driving jobs 10 years)</h3>
        <Table caption="Jobs" rows={rows} rowKey={row => row.kind === 'job' ? row.job.id : `${row.from}_${row.to}`} columns={[
          { key: 'e', label: 'Employer', primary: true, cell: row => row.kind === 'job' ? <><span className="font-medium">{row.job.company}</span><span className="block text-[13px] text-muted-foreground">{row.job.city}, {row.job.state} · {row.job.phone}</span></>
            : <><span className="font-medium">Gap</span><span className="block whitespace-pre-wrap text-[13px] text-muted-foreground">Driver: {row.explanation || 'not explained'}</span></> },
          { key: 'p', label: 'Position', cell: row => row.kind === 'job' ? row.job.position : '—' },
          { key: 'd', label: 'Dates', muted: true, nowrap: true, cell: row => row.kind === 'job' ? span(row.job.fromMonth, row.job.toMonth) : span(row.from, row.to) },
          { key: 'f', label: 'Federal rules', cell: row => row.kind === 'gap' ? <Badge label="Gap" tone="warning" />
            : row.job.drove === 'NO' && row.job.fmcsr === 'NO' && row.job.dotTesting === 'NO' ? <span className="text-[13px] text-muted-foreground">Not regulated</span>
            : <span className="flex flex-wrap gap-1.5">{row.job.drove === 'YES' && <Badge label="CMV" tone="info" />}{(row.job.fmcsr === 'UNSURE' || (row.job.fmcsr === 'YES' && row.job.drove !== 'YES' && row.job.dotTesting !== 'YES')) && <Badge label={row.job.fmcsr === 'UNSURE' ? 'Rules: not sure' : 'Federal rules'} tone="info" />}
              {row.job.dotTesting !== 'NO' && <Badge label={row.job.dotTesting === 'UNSURE' ? 'Testing: not sure' : 'DOT testing'} tone="info" />}</span> },
          { key: 'l', label: 'Why they left', hideBelow: 'xl', cell: row => row.kind === 'job' ? (row.job.toMonth ? row.job.reasonLeft || '—' : 'Still works there') : '—' },
        ]} empty={<p className="text-sm text-muted-foreground">No jobs given.</p>} />
        {history.noEarlierDriving && <p className="text-[13px] text-muted-foreground">The driver confirmed they didn’t drive a commercial vehicle for work before their oldest job.</p>}</section>
      <section className="space-y-2"><h3 className="text-sm font-medium">Accidents, tickets and licenses (3 years)</h3>
        <DescriptionList items={[
          { label: 'Accidents', value: history.accidents === 'YES' ? <ul className="space-y-1">{(history.accidentList ?? []).map(item => <li key={item.id}>{item.description} · {monthLabel(item.month)} · {item.state}</li>)}</ul> : answer(history.accidents, '') },
          { label: 'Tickets', value: history.tickets === 'YES' ? <ul className="space-y-1">{(history.ticketList ?? []).map(item => <li key={item.id}>{item.violation} · {monthLabel(item.month)} · {item.state} · {item.vehicle === 'CMV' ? 'commercial vehicle' : 'other vehicle'}</li>)}</ul> : answer(history.tickets, '') },
          { label: 'Other licenses', value: history.otherLicenses === 'YES' ? <ul className="space-y-1">{(history.licenseList ?? []).map(item => <li key={item.id}>{item.state} · {licenseTypes[item.licenseClass as keyof typeof licenseTypes] ?? item.licenseClass} · {item.number}</li>)}</ul> : answer(history.otherLicenses, '') },
          { label: 'Denied, suspended or revoked', value: history.licenseTrouble === 'YES' ? <span className="whitespace-pre-wrap">Yes: {history.licenseTroubleNote}</span> : history.licenseTrouble === 'NO' ? 'No' : 'Not answered' }]} />
      </section>
    </CardBody>
  </Card>;
}
