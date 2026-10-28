import type { Metadata } from 'next';
import { BrandWordmark } from '@/components/brand-wordmark';
import { AppearanceSelect } from '@/components/appearance-select';
import { ToastProvider } from '@/components/ui/toast';
import { brand } from '@/lib/brand';
export const metadata: Metadata = { title: 'Dispatcher application', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <ToastProvider><div className="min-h-screen border-t-4 border-t-brand-orange bg-background px-4 py-6 text-foreground sm:py-10">
    <a href="#application" className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-card focus:p-4">Skip to application</a>
    <div className="mx-auto max-w-3xl">
      <header className="mb-8 flex items-center justify-between gap-4 border-b pb-6"><BrandWordmark /><AppearanceSelect /></header>
      <main id="application" tabIndex={-1}>{children}</main>
      <footer className="mt-10 border-t pt-5 text-xs text-muted-foreground">{brand.companyName} · Dispatcher application</footer>
    </div>
  </div></ToastProvider>;
}
