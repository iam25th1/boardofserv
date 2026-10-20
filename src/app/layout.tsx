import type { Metadata, Viewport } from "next";
import { Onest, Caveat } from "next/font/google";
import "../design/tokens.css";
import "./globals.css";
import { Providers } from "./providers";
import { ChalkFilter } from "@/components/ChalkFilter";
import { palette } from "@/design/palette";
import { themeInitScript } from "@/lib/theme-init";

// Onest for everything you read. Caveat only for the small handwritten notes.
const onest = Onest({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-onest",
  display: "swap",
});
const caveat = Caveat({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-caveat",
  display: "swap",
});

export const metadata: Metadata = {
  title: "boardofserv",
  description: "Describe an agent in plain English and build it on OpenServ.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: palette.dark.slate },
    { media: "(prefers-color-scheme: light)", color: palette.light.slate },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${onest.variable} ${caveat.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ChalkFilter />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
