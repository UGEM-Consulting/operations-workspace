import { requireIdentity } from '@/lib/auth';
import { LogoutButton } from '@/features/auth/logout-button';
import { BrandWordmark } from '@/components/brand-wordmark';
import { Navigation } from '@/components/navigation';
import { ThemeToggle } from '@/components/theme-toggle';
import { brand } from '@/lib/brand';
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const identity = await requireIdentity();
  return <div className="min-h-screen md:grid md:grid-cols-[260px_1fr]">
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-card focus:p-4">Skip to content</a>
    <aside className="border-b border-t-4 border-t-brand-orange bg-card md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:overflow-y-auto md:border-r md:border-b-0">
      <BrandWordmark className="px-6 py-7" />
      <p className="hidden px-7 pb-2 text-[10px] font-semibold tracking-[.18em] text-muted-foreground md:block">WORKSPACE</p>
      <Navigation items={identity.navigation} />
      <div className="m-5 mt-auto hidden rounded-xl border bg-background p-4 md:block"><p className="text-xs font-semibold">People and operations</p><p className="mt-2 text-xs leading-5 text-muted-foreground">One place for your team’s onboarding and daily work.</p></div>
    </aside>
    <div className="min-w-0">
      <header className="flex min-h-20 flex-wrap items-center justify-between gap-3 border-b bg-card px-5 py-4 md:px-9">
        <p className="text-sm font-medium">{brand.applicationName}</p>
        <div className="flex items-center gap-3"><span className="hidden max-w-48 truncate text-xs text-muted-foreground lg:block">{identity.user.firstName} {identity.user.lastName}</span><ThemeToggle /><LogoutButton /></div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-[1440px] p-5 py-9 md:p-9 lg:p-12">{children}</main>
      <footer className="px-5 pb-6 text-xs leading-5 text-muted-foreground md:px-12">{brand.displayName} · Internal platform</footer>
    </div>
  </div>;
}
