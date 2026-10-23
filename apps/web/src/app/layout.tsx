import type { Metadata } from "next";
import localFont from "next/font/local";
import { brand } from "@/lib/brand";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";
const epilogue = localFont({ src: '../assets/fonts/Epilogue-Variable.ttf', variable: '--font-epilogue', display: 'swap', weight: '100 900' });
const anton = localFont({ src: '../assets/fonts/Anton-Regular.ttf', variable: '--font-anton', display: 'swap', weight: '400' });
// Authenticated and applicant pages are always rendered per request.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: { default: brand.displayName, template: `%s | ${brand.displayName}` }, applicationName: brand.displayName, description: brand.description };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><body className={`${epilogue.variable} ${anton.variable} font-sans antialiased`}><ThemeProvider>{children}</ThemeProvider></body></html>;
}
