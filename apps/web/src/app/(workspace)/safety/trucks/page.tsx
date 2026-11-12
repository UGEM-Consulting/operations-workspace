import { redirect } from 'next/navigation';
// Trucks became Units (section 34); old links land there.
export default function TrucksPage() { redirect('/safety/units'); }
