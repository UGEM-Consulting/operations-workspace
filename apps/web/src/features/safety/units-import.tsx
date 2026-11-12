'use client';
import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PageCrumb } from '@/components/shell-context';
import { PageHeader } from '@/components/workspace-ui';
import { CsvImport, type ImportSetup } from './csv-import';

const SETUP: ImportSetup = {
  columns: [['unit', 'number'], ['type', 'type'], ['trailer_type', 'trailerType'], ['year', 'year'], ['make', 'make'], ['vin', 'vin'], ['plate', 'plate'], ['plate_state', 'plateState'],
    ['owner', 'owner'], ['responsible', 'responsible'], ['registration_expires', 'registrationExpiresOn'], ['inspected_on', 'inspectedOn']],
  optional: ['trailer_type', 'plate', 'plate_state', 'responsible', 'registration_expires', 'inspected_on'],
  template: [
    { number: '233', type: 'Semi truck', year: '2021', make: 'Freightliner Cascadia', vin: '1FUJHHDR3MLMA1234', plate: 'P123456', plateState: 'IL', owner: 'Yemba Invest LLC', responsible: 'Owen Staff', registrationExpiresOn: '2027-03-31', inspectedOn: '2026-04-12' },
    { number: 'P-12', type: 'Pickup', year: '2022', make: 'Ford F-350', vin: '1FT8W3DT5NEC12345', owner: 'Casey Lin', responsible: 'Owen Staff' },
    { number: 'T-108', type: 'Trailer', trailerType: '53 ft dry van', year: '2019', make: 'Utility 4000D-X', vin: '1UYVS2539KU123456', owner: 'Company', inspectedOn: '2026-02-01' }],
  noun: ['unit', 'units'], steps: ['Upload the file', 'Check the rows', 'Add units'], check: 'safety/units/check', add: 'safety/units/add', templateName: 'units-template.csv',
  choiceLabels: { type: ['Type', 'Use this type'], owner: ['Owner', 'Use this owner'], responsible: ['Responsible', 'Use this staff member'] },
  guide: [{ label: 'Unit', value: 'The number on the truck or trailer, and its type: Semi truck, Pickup or Trailer (with the trailer type)' },
    { label: 'Truck', value: 'Model year, make and model, VIN, and the plate with its state' },
    { label: 'Owner', value: 'The truck owner’s company, the owner-operator’s name (add those drivers first), or Company for a company trailer' },
    { label: 'Responsible', value: 'The Safety Manager who keeps its papers, if you know' },
    { label: 'Dates', value: 'Registration expiration and the last yearly inspection. Permits are added on the unit’s page' }],
  guideNote: 'No lease terms, pay or tax IDs. Those stay in the paper contracts.',
  uploadNote: 'Add owner-operators as drivers first, so a row can name them. Nothing is saved until you confirm on the last step, and the file itself is never kept.',
  addNote: 'They go on the Units list straight away, and new truck owners chosen above are added with them.',
};

/** Safety › Units › Add from a file (UnitsCheckRowsScreen). */
export function UnitsImport() {
  return <div className="space-y-6">
    <PageCrumb label="Add from a file" />
    <PageHeader title="Add units from a file" description="Trucks and trailers already on the road, from a list. Each row is checked before anything is saved." />
    <CsvImport setup={SETUP} done={(result, again) => <>
      <Alert tone="success" title={`Added ${result.added} ${result.added === 1 ? 'unit' : 'units'}`}><p>They’re on the Units list now. Add permits and papers on each unit’s page.</p></Alert>
      <div className="flex flex-wrap gap-2"><Button asChild><Link href="/safety/units">Go to Units</Link></Button><Button variant="outline" onClick={again}>Upload another file</Button></div></>} />
  </div>;
}
