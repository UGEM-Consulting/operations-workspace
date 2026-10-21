import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";
export const metadata: Metadata = { title: { default: "Operations Workspace", template: "%s | Operations Workspace" }, description: "Internal operations workspace — project foundation." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><body className="font-sans antialiased"><ThemeProvider>{children}</ThemeProvider></body></html>;
}
