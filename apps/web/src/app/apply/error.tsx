'use client';
import { RouteError } from '@/components/route-error';
export default function ApplyError({ retry }: { error: unknown; retry: () => void }) {
  return <div className="space-y-4"><h1 className="text-2xl">Application temporarily unavailable</h1><RouteError retry={retry} title="We could not load your application" /></div>;
}
