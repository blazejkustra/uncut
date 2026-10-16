// The root layout: fonts preloaded, the global styles (DM Sans and DM Mono, self-hosted under
// /assets/fonts with their OFL), and analytics started after hydration (components/Analytics.tsx).
import type { Metadata, Viewport } from "next";
import Analytics from "../components/Analytics.tsx";
import { SITE_URL } from "../lib/site.ts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Uncut: edit videos by talking to an agent", template: "%s | Uncut" },
  icons: {
    icon: [{ url: "/assets/favicon-32.png", sizes: "32x32", type: "image/png" }],
    apple: "/assets/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preload" href="/assets/fonts/DMSans-Variable.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
