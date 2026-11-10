'use client';
import { Checkbox } from '@/components/ui/field';

/** What a dispatch manager can ask IT to set up for a support or updater (section 32), in the API's order. */
export const SUPPORT_IT_ITEMS = [
  { key: 'COMPANY_EMAIL', label: 'Company email', description: 'A Google Workspace account.' },
  { key: 'RINGCENTRAL', label: 'RingCentral number', description: 'A work number with SMS and call recording.' },
  { key: 'BUSINESS_SOFTWARE', label: 'Business software', description: 'Load boards and other business apps.' },
  { key: 'EQUIPMENT', label: 'Equipment', description: 'Laptop, headset or other equipment.' },
] as const;
export type SupportItItem = typeof SUPPORT_IT_ITEMS[number]['key'];

/** The checklist tasks each choice adds, to say what an open request covers. */
const TASKS: Record<SupportItItem, string[]> = { COMPANY_EMAIL: ['GOOGLE_WORKSPACE'], RINGCENTRAL: ['RINGCENTRAL', 'SMS', 'CALL_RECORDING'], BUSINESS_SOFTWARE: ['BUSINESS_SOFTWARE'], EQUIPMENT: ['EQUIPMENT'] };
/** "RingCentral number and business software" from the tasks of an open request. */
export function askedFor(taskKeys: string[], midSentence = false) {
  // Sentence case after the first: "Company email, RingCentral number and equipment".
  const labels = SUPPORT_IT_ITEMS.filter(item => TASKS[item.key].some(key => taskKeys.includes(key))).map((item, index) => (index === 0 && !midSentence) || item.key === 'RINGCENTRAL' ? item.label : item.label.toLowerCase());
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0] ?? '';
}

/** The four choices as checkboxes (SupportApprovalItScreen, SupportAskItScreen). */
export function SupportItChoices({ value, onChange, disabled = false }: { value: SupportItItem[]; onChange: (next: SupportItItem[]) => void; disabled?: boolean }) {
  return <div className="space-y-3">
    {SUPPORT_IT_ITEMS.map(item => <Checkbox key={item.key} label={item.label} description={item.description} disabled={disabled} checked={value.includes(item.key)}
      onChange={event => onChange(event.target.checked ? [...value, item.key] : value.filter(key => key !== item.key))} />)}
  </div>;
}
