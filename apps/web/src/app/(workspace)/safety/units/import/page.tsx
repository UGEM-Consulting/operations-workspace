import { requirePage } from '@/lib/auth';
import { UnitsImport } from '@/features/safety/units-import';
export const metadata = { title: 'Add units from a file' };
export default async function UnitsImportPage() {
  await requirePage('units');
  return <UnitsImport />;
}
