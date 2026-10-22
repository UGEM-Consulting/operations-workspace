"use client";
import { Button } from '@/components/ui/button';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <div className="mx-auto max-w-lg p-10"><h1 className="text-2xl font-normal">Workspace temporarily unavailable</h1><p className="my-4 text-muted-foreground">We could not load this page. Please try again in a moment. If the problem continues, contact your workspace administrator.</p><Button onClick={reset}>Try again</Button></div>;
}
