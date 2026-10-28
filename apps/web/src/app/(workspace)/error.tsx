'use client';
import { RouteError } from '@/components/route-error';
// Rendered inside the workspace shell, so navigation stays available while the page retries.
export default function WorkspaceError({ retry }: { error: unknown; retry: () => void }) {
  return <div className="max-w-2xl space-y-4"><h1 className="font-sans text-[22px] font-semibold leading-[30px]">Page unavailable</h1><RouteError retry={retry} /></div>;
}
