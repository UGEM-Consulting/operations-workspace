import { FileSignature } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import { consentLabels, type DriverProfile } from './types';

/**
 * The consent forms the driver signed in their application, each with its signed copy (the exact version plus a
 * signature certificate), and the published forms they still need to sign. Every Safety role sees this card.
 */
export function ConsentCard({ driver }: { driver: DriverProfile }) {
  const consents = driver.consents!;
  // The driver can still sign only while their application is with them; a submitted one predates the missing forms.
  const canSign = driver.status === 'LEAD' || driver.status === 'APPLYING';
  return <Card>
    <CardHeader title="Consent forms" description="Signed or acknowledged by the driver in their application. Each signed copy is the exact version, with a signature certificate." />
    {consents.signatures.length ? <ul className="mt-3 divide-y divide-border border-t border-border">{consents.signatures.map(row => <li key={row.documentId} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
      <FileSignature aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{consentLabels[row.kind] ?? row.kind}<span className="font-normal text-muted-foreground"> · {row.title}, version {row.version}</span></p>
        <p className="text-[13px] text-muted-foreground">{row.hasSignature === false ? 'Acknowledged' : 'Signed'} by {row.typedName} · <LocalTime iso={row.signedAt} /></p>
      </div>
      <Button asChild size="sm" variant="ghost"><a href={`/api/backend/safety/drivers/${driver.id}/consents/${row.documentId}/signed`} target="_blank" rel="noopener">Signed copy<span className="sr-only">: {consentLabels[row.kind] ?? row.kind}, version {row.version}</span></a></Button>
    </li>)}</ul> : <CardBody><EmptyState compact title="Nothing signed yet" description="The driver signs the published consent forms in their application." /></CardBody>}
    {consents.missing.length > 0 && <CardBody className="border-t border-border text-sm">
      <p className="flex flex-wrap items-center gap-2"><Badge label={canSign ? 'Still to sign' : 'Not signed'} tone={canSign ? 'warning' : 'neutral'} />{consents.missing.map(code => consentLabels[code.slice('consent:'.length)] ?? code).join(', ')}</p>
      {!canSign && driver.application?.status === 'SUBMITTED' && <p className="mt-1 text-[13px] text-muted-foreground">Published after the driver sent their application.
        {driver.status === 'SCREENING' && ' For the background check authorization, confirm a signed paper copy when you upload the MVR.'}</p>}
    </CardBody>}
  </Card>;
}
