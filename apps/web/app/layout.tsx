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
            <nav className="nav">
              {/*
                The reliability number is a top-level destination, not a tab inside a
                settings page. "The reliability numbers as the pitch, not a tab" is a line
                in the plan, and this is the whole of what it means in the navigation.
              */}
              <a href="/reliability">Reliability</a>
            </nav>
            <span className="tenant">{TENANT.name}</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
