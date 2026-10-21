import { requirePage } from '@/lib/auth';
import { Suspense } from "react";
import Link from "next/link";
import { ArrowUpRight, UserPlus, Mail, ClipboardList, Monitor, ArrowRight, Layers } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BackendStatus, HealthLoading } from "@/features/dashboard/backend-status";
export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };
const modules = [
  { title: "Dispatcher onboarding", description: "A consistent start for every new dispatcher.", href: "/onboarding", icon: UserPlus },
  { title: "Invitations", description: "Your future starting point for welcoming applicants.", href: "/onboarding/invitations", icon: Mail },
  { title: "Applications", description: "A dedicated space to organize incoming applications.", href: "/onboarding/applications", icon: ClipboardList },
  { title: "IT tasks", description: "A home for equipment and access coordination.", href: "/it/tasks", icon: Monitor },
];
export default async function Dashboard() {
  const identity = await requirePage("dashboard");
  const visibleModules = modules.filter(module => identity.navigation.some(item => item.href === module.href));
  return <div className="space-y-8"><div><p className="text-xs font-semibold tracking-[.16em] text-primary">YOUR OPERATIONS, CONNECTED</p><h1 className="mt-3 text-3xl font-normal tracking-tight md:text-4xl">Workspace overview</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">A shared home for the work that keeps your team moving.</p></div>
    <section className="relative overflow-hidden rounded-2xl bg-brand-panel p-7 text-brand-panel-foreground md:p-9"><div className="relative z-10 max-w-xl"><span className="rounded-full border border-white/25 px-3 py-1 text-[10px] font-semibold tracking-widest text-brand-orange">FOUNDATION RELEASE</span><h2 className="mt-6 text-2xl font-semibold tracking-tight">Good operations start with a strong foundation.</h2><p className="mt-3 text-sm leading-6 text-brand-panel-foreground/80">Your workspace is taking shape. Dispatcher onboarding comes first, with room for your people and processes to grow.</p><Button asChild className="mt-6 bg-brand-orange text-brand-ink hover:bg-brand-orange/90"><Link href={identity.landingPage === "/dashboard" ? "/settings" : identity.landingPage}>Open your workspace <ArrowRight className="size-4" /></Link></Button></div><Layers aria-hidden className="absolute -right-8 top-8 size-64 -rotate-12 text-white/5" /></section>
    <section aria-labelledby="modules-title"><div className="mb-4 flex items-center justify-between"><h2 id="modules-title" className="text-lg font-semibold">Workspace modules</h2><span className="text-xs text-muted-foreground">Built to grow with you</span></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{visibleModules.map(({ title, description, href, icon: Icon }) => <Link key={href} href={href} className="group rounded-xl focus-visible:outline-2 focus-visible:outline-primary"><Card className="h-full p-5 transition-colors group-hover:border-primary/50"><div className="flex items-center justify-between"><div className="rounded-lg bg-accent p-2.5 text-primary"><Icon className="size-5" /></div><ArrowUpRight className="size-4 text-muted-foreground" /></div><h3 className="mt-5 text-sm font-semibold">{title}</h3><p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p><p className="mt-5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Planned · Preview only</p></Card></Link>)}</div></section>
    <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]"><Card className="p-6"><h2 className="text-sm font-semibold">A clear path forward</h2><div className="mt-6 space-y-5">{[["01", "Project foundation", "Application shell, API connection, and deployment setup.", "Current"], ["02", "Dispatcher onboarding", "Forms and business workflows in a future milestone.", "Up next"]].map(([number, title, description, state]) => <div className="flex items-start gap-4" key={number}><span className="rounded-lg bg-muted p-2.5 text-xs font-semibold text-muted-foreground">{number}</span><div className="flex-1"><p className="text-sm font-medium">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div><span className="rounded-full bg-accent px-2 py-1 text-[10px] font-semibold text-primary">{state}</span></div>)}</div></Card><Suspense fallback={<HealthLoading />}><BackendStatus /></Suspense></div>
  </div>;
}
