import type { Metadata } from "next";
import localFont from "next/font/local";
import { brand } from "@/lib/brand";
import { isStaging } from "@/lib/deployment";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";
const epilogue = localFont({ src: '../assets/fonts/Epilogue-Variable.ttf', variable: '--font-epilogue', display: 'swap', weight: '100 900' });
const anton = localFont({ src: '../assets/fonts/Anton-Regular.ttf', variable: '--font-anton', display: 'swap', weight: '400' });
// Authenticated and applicant pages are always rendered per request.
export const dynamic = 'force-dynamic';
export function generateMetadata(): Metadata {
  const name = isStaging() ? `${brand.displayName} (Staging)` : brand.displayName;
  return { title: { default: name, template: `%s | ${name}` }, applicationName: brand.displayName, description: brand.description, ...(isStaging() ? { robots: { index: false, follow: false } } : {}) };
}
function StagingBanner() {
  return <p role="note" className="border-b border-warning-border bg-warning-background px-4 py-1.5 text-center text-xs font-medium text-foreground">Staging: for staff testing only. Nothing here affects the live workspace.</p>;
}
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><body className={`${epilogue.variable} ${anton.variable} font-sans antialiased`}><ThemeProvider>{isStaging() && <StagingBanner />}{children}</ThemeProvider></body></html>;
}
