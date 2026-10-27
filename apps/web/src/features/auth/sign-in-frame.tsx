import type { ReactNode } from 'react';
import { BrandWordmark } from '@/components/brand-wordmark';
import { Card } from '@/components/ui/card';
import { ThemeToggle } from '@/components/theme-toggle';
import { brand } from '@/lib/brand';
/** Page frame for the steps after a correct password. */
export function SignInFrame({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <main className="flex min-h-dvh flex-col p-5 sm:p-8">
    <header className="flex items-center justify-between gap-4"><BrandWordmark /><ThemeToggle /></header>
    <div className="mx-auto flex w-full max-w-lg flex-1 items-center py-10">
      <Card className="w-full border-t-4 border-t-brand-orange p-6 sm:p-8">
        <h1 className="font-display text-3xl">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
        {children}
      </Card>
    </div>
    <footer className="text-center text-xs leading-5 text-muted-foreground">{brand.companyName} · Internal staff workspace</footer>
  </main>;
}
