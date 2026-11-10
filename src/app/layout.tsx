import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "../design/tokens.css";
import "./globals.css";
import { Providers } from "./providers";
import { ChalkFilter } from "@/components/ChalkFilter";
import { palette } from "@/design/palette";
import { themeInitScript } from "@/lib/theme-init";
import { rootMetadata } from "@/lib/shareMeta";

// Onest for everything you read. Caveat only for the small handwritten notes.
// Both are in the repo (src/app/fonts, the latin files Google Fonts serves,
// under the SIL Open Font License), so no build or deploy fetches a font.
// Each is one variable file covering the weights the app uses.
const onest = localFont({
  src: "./fonts/onest-latin.woff2",
  weight: "400 700",
  variable: "--font-onest",
  display: "swap",
});
const caveat = localFont({
  src: "./fonts/caveat-latin.woff2",
  weight: "400 700",
  variable: "--font-caveat",
  display: "swap",
});

export const metadata: Metadata = rootMetadata;

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: palette.dark.slate },
    { media: "(prefers-color-scheme: light)", color: palette.light.slate },
  ],
  width: "device-width",
  initialScale: 1,
  // Lets the composer and the top bar read the safe-area insets on phones.
  viewportFit: "cover",
  // The on-screen keyboard shrinks the page (where the browser allows it,
  // as Chrome does) rather than covering it, so 100dvh means what's left.
  interactiveWidget: "resizes-content",
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
