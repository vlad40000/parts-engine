import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Parts Engine",
  description: "Road Runner Appliance — intake, parts lists, eBay evidence and harvest decisions."
};

const NAV = [
  { href: "/", label: "Fleet" },
  { href: "/intake", label: "Intake" },
  { href: "/bom", label: "Parts lists" },
  { href: "/mpns", label: "MPNs" },
  { href: "/teardown", label: "Teardown queue" },
  { href: "/settings", label: "Settings" }
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-line bg-white">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="font-semibold tracking-tight">
              <span className="text-accent">Road Runner</span> Parts Engine
            </Link>
            <nav className="flex flex-wrap gap-1 text-sm">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="rounded px-2 py-1 text-muted hover:bg-paper hover:text-ink">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
