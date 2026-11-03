import { LocalTime } from '@/components/ui/local-time';
import { Badge } from '@/components/ui/status-badge';
import type { StaffDocuments } from '@/features/onboarding/types';
import type { ViewableDocument } from './document-modal';

/** What a document is called on screen. */
export const shortName = (doc: { kind: string; label: string }) => doc.kind === 'NDA' || doc.kind === 'SOP' ? doc.kind : doc.label;
/** Someone's signed copies for the viewer, each with its signing record. Works on server-rendered pages. */
export function signedDocuments(items: StaffDocuments['items'], base: string, person: string): ViewableDocument[] {
  return items.flatMap(doc => {
    const signed = doc.applicant, company = doc.company;
    if (!signed) return [];
    return [{ url: `${base}/${signed.documentId}/signed`, title: `${shortName(doc)}${person.trim() ? ` · ${person.trim()}` : ''}`, meta: doc.requiresSignature ? 'Signed copy' : 'Read', certificate: true,
      record: [
        { label: 'Status', value: !doc.requiresSignature ? <Badge label="Read" tone="success" /> : company ? <Badge label="Fully signed" tone="success" /> : <Badge label="Signed" tone="success" /> },
        { label: `${signed.typedName} ${doc.requiresSignature ? 'signed' : 'read it'}`, value: <LocalTime iso={signed.signedAt} /> },
        ...(signed.signatureMethod ? [{ label: 'How', value: signed.signatureMethod === 'TYPED' ? 'Adopted from their typed name' : 'Drawn signature' }] : []),
        ...(company ? [{ label: `${company.typedName} countersigned`, value: <LocalTime iso={company.signedAt} /> }] : []),
        { label: 'Version', value: signed.publishedAt ? <>Published <LocalTime iso={signed.publishedAt} format="date" /></> : 'An earlier version' },
      ],
      details: [
        { label: 'IP address', value: signed.ipAddress ?? 'Not recorded' }, { label: 'Browser', value: signed.userAgent ?? 'Not recorded' },
        ...(signed.documentSha256 ? [{ label: 'Document fingerprint', value: <span className="break-all font-mono text-xs">{signed.documentSha256}</span> }] : []),
      ] }];
  });
}
