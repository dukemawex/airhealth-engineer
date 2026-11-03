import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });
// Studio display face for bold headlines and numbers.
const grotesk = Space_Grotesk({ subsets: ["latin"], display: "swap", variable: "--font-grotesk", weight: ["500", "600", "700"] });

/** Applies the saved theme before first paint (dark is the default). */
const THEME_SCRIPT = `try{var t=localStorage.getItem("airhealth.theme");if(t==="light")document.documentElement.dataset.theme="light"}catch(e){}`;

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
    "An agent that engineers your indoor air: Muse Spark plans purifier, window and HVAC control from live air data, the 72-hour forecast and a photo of your room, with every device action approved by you. Not medical advice.",
  applicationName: "AirHealth Engineer",
};

export const viewport: Viewport = {
  themeColor: "#07090c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
