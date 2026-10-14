import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

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
  title: "SME Finance Copilot",
  description: "Synthetic-data sandbox finance agent (FinTechathon 2026, Topic E)",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
