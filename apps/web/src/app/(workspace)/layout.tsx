import { requireIdentity } from '@/lib/auth';
import { LogoutButton } from '@/features/auth/logout-button';
import { Truck, ChevronRight } from "lucide-react";
import { Navigation } from "@/components/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const identity = await requireIdentity();
  return <div className="min-h-screen md:grid md:grid-cols-[260px_1fr]">
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-card focus:p-4">Skip to content</a>
    <aside className="border-b bg-card md:sticky md:top-0 md:flex md:h-screen md:flex-col md:border-r md:border-b-0">
      <div className="flex items-center gap-3 px-6 py-7"><div className="rounded-xl bg-primary p-2.5 text-primary-foreground"><Truck className="size-6" /></div><div><p className="text-sm font-bold tracking-tight">OPERATIONS</p><p className="text-xs tracking-[.18em] text-muted-foreground">WORKSPACE</p></div></div>
      <p className="hidden px-7 pb-2 text-[10px] font-semibold tracking-[.18em] text-muted-foreground md:block">WORKSPACE</p><Navigation items={identity.navigation} />
      <div className="m-5 mt-auto hidden rounded-xl border bg-background p-4 md:block"><p className="text-xs font-semibold">Built for the road ahead</p><p className="mt-2 text-xs leading-5 text-muted-foreground">One place for your people, processes, and daily operations.</p><span className="mt-4 inline-block rounded bg-accent px-2 py-1 text-[10px] font-semibold text-primary">MILESTONE 02</span></div>
    </aside>
    <div className="min-w-0"><header className="flex h-20 items-center justify-between border-b bg-card px-5 md:px-9"><div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground">Workspace</span><ChevronRight className="size-3 text-muted-foreground" /><span className="font-medium">Operations</span></div><div className="flex items-center gap-4"><span className="hidden text-xs text-muted-foreground sm:block">{identity.user.firstName} {identity.user.lastName}</span><ThemeToggle /><LogoutButton /></div></header><main id="main" className="mx-auto max-w-[1440px] p-5 py-9 md:p-9 lg:p-12">{children}</main><footer className="px-5 pb-6 text-xs text-muted-foreground md:px-12">Operations Workspace <span className="mx-2">/</span> Internal platform · Milestone 2</footer></div>
  </div>;
}
