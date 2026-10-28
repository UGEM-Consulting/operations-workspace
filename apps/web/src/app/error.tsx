'use client';
import { RouteError } from '@/components/route-error';
// retry() re-fetches the server components and re-renders the segment (reset() alone would re-render stale data).
export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return <main className="mx-auto max-w-lg p-6 sm:p-10"><h1 className="mb-4 text-2xl">Workspace temporarily unavailable</h1><RouteError retry={retry} title="We could not load this page" /></main>;
}
