import type { Metadata } from "next";
import { TENANT } from "@/lib/demo-data";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ledgerline",
  description: "Every call answered. Every job booked.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <a href="/" className="brand">
              <span className="brand-mark" aria-hidden>
                L
              </span>
              <span>Ledgerline</span>
            </a>
            <span className="tenant">{TENANT.name}</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
