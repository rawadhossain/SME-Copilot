import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { CsrfFetch } from "@/ui/session";

// Fonts are committed under ./fonts (Geist, SIL OFL). No external font CDN.
const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Ledgerhand · decision room",
  description: "A finance agent that investigates and proposes; the owner signs the limits; everything is verified and logged. Synthetic-data sandbox (FinTechathon 2026, Topic E).",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <CsrfFetch />
        {children}
      </body>
    </html>
  );
}
