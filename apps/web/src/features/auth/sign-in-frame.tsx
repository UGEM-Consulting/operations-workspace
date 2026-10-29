import type { ReactNode } from 'react';
import { Layers, type LucideIcon } from 'lucide-react';
import { ThemeToggle } from '@/components/theme-toggle';
import { brand } from '@/lib/brand';
import { cn } from '@/lib/utils';

/**
 * The sign-in pages: a dark brand panel beside the form on computers; below 1024px the form alone with a small wordmark.
 * The form's h1 is the first heading; the panel's headline is not a heading.
 */
export function SignInShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className="grid min-h-dvh bg-background lg:grid-cols-[1.1fr_1fr]">
    <section aria-label="About the workspace" className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-12 text-sidebar-active-foreground lg:flex">
      <p className="flex items-center gap-3 font-display text-[22px] leading-[26px] tracking-[.02em]"><span className="grid size-10 place-items-center rounded-md bg-brand-orange text-brand-ink"><Layers aria-hidden="true" className="size-[22px]" /></span>{brand.companyName}</p>
      <div className="relative z-10">
        <p className="text-[11px] font-semibold uppercase leading-4 tracking-[.08em] text-sidebar-accent">{brand.displayName}</p>
        <p className="mt-4 font-display text-[56px] leading-[60px]">People. Processes.<br />One workspace.</p>
        <p className="mt-4 max-w-[400px] text-base leading-[26px] text-sidebar-foreground">Onboarding, IT setup and the daily work that keeps dispatch moving.</p>
      </div>
      <p className="relative z-10 text-[13px] text-sidebar-muted">Internal staff workspace</p>
      <span aria-hidden="true" className="absolute -bottom-30 -right-30 size-90 rounded-full bg-brand-orange" />
    </section>
    <div className="flex min-w-0 flex-col">
      <div className="flex justify-end p-3 sm:p-4"><ThemeToggle /></div>
      <main className="flex flex-1 justify-center px-4 pb-10 pt-2 sm:pt-6 lg:items-center lg:px-12 lg:py-12">
        <div className={cn('w-full', wide ? 'max-w-[440px]' : 'max-w-[380px]')}>
          <p className="mb-8 flex items-center gap-3 font-display text-xl leading-6 tracking-[.02em] lg:hidden"><span className="grid size-7 place-items-center rounded-sm bg-brand-orange text-brand-ink"><Layers aria-hidden="true" className="size-4" /></span>{brand.displayName}</p>
          {children}
        </div>
      </main>
      <footer className="pb-5 text-center text-xs text-muted-foreground lg:hidden">{brand.companyName} · Internal staff workspace</footer>
    </div>
  </div>;
}
/** Title block for a sign-in step, with an optional icon tile. */
export function SignInHeading({ title, description, icon: Icon }: { title: string; description: ReactNode; icon?: LucideIcon }) {
  return <div>
    {Icon && <span aria-hidden="true" className="mb-4 inline-grid size-12 place-items-center rounded-md bg-brand-subtle text-brand-subtle-foreground"><Icon className="size-6" /></span>}
    <h1 className="font-sans text-[22px] font-semibold leading-[30px] tracking-[-0.01em]">{title}</h1>
    <p className="mt-1 text-sm leading-[22px] text-muted-foreground">{description}</p>
  </div>;
}
/** Page frame for the steps after a correct password. */
export function SignInFrame({ title, description, icon, wide = true, children }: { title: string; description: ReactNode; icon?: LucideIcon; wide?: boolean; children: ReactNode }) {
  return <SignInShell wide={wide}><SignInHeading title={title} description={description} icon={icon} />{children}</SignInShell>;
}
