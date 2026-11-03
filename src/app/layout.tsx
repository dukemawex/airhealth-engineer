import type { Metadata, Viewport } from "next";
import { Inter, Newsreader } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });
// Editorial serif for headlines, kickers' companions and briefing copy (optical sizes for display and text).
const newsreader = Newsreader({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-newsreader",
  style: ["normal", "italic"],
  axes: ["opsz"],
});

function siteUrl(): URL | undefined {
  const raw = process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
  try {
    return raw ? new URL(raw) : undefined;
  } catch {
    return undefined;
  }
}

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: "AirHealth Engineer",
  description:
    "An autonomous Muse Spark agent that turns live air quality and your health context into engineered, human-approved protection.",
  applicationName: "AirHealth Engineer",
};

export const viewport: Viewport = {
  themeColor: "#084b59",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${newsreader.variable}`}>
      <body>{children}</body>
    </html>
  );
}
