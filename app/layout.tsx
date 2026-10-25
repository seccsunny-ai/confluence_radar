import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Confluence Radar",
  description: "TradingView screener signals, stored and filtered, with Gold → BOS/CHoCH tracking.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
