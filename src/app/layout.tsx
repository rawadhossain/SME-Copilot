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
  title: { default: "Ledgerhand", template: "%s · Ledgerhand" },
  description: "Ledgerhand watches your cash, suggests fixes, and acts only inside the limits you set.",
  robots: { index: false, follow: false }, // a private application: nothing here should be indexed
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
