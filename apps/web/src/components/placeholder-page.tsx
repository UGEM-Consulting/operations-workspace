import Link from "next/link";
import { Construction, ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return <div><p className="text-xs font-semibold uppercase tracking-widest text-primary">Workspace preview</p><h1 className="mt-3 text-3xl font-semibold tracking-tight">{title}</h1><p className="mt-3 text-sm text-muted-foreground">{description}</p><Card className="mt-8 flex min-h-80 flex-col items-center justify-center p-8 text-center"><div className="rounded-2xl bg-accent p-4 text-primary"><Construction className="size-7" /></div><h2 className="mt-5 text-xl font-semibold">A place for what’s next</h2><p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">This module is reserved for a future milestone. The workspace foundation is ready; workflows and records will follow.</p><Button asChild variant="outline" className="mt-6"><Link href="/dashboard"><ArrowLeft className="size-4" />Back to overview</Link></Button></Card></div>;
}
