import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Fraunces } from "next/font/google";
import "../design/tokens.css";
import "./globals.css";
import { Providers } from "./providers";

// UI face: a humanist grotesk with warmth and strong legibility. Display face:
// an optical serif, used only for the wordmark and the one welcome line.
const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-hanken",
  display: "swap",
});
const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});

export const metadata: Metadata = {
  title: "boardofserv",
  description: "Describe an agent in plain English and build it on OpenServ.",
};

export const viewport: Viewport = {
  themeColor: "#f6f7f6",
  width: "device-width",
  initialScale: 1,
};

// Set the theme before paint so there is no flash. Falls back to the system
// preference when the user has not chosen one.
const themeInit = `
(function(){try{var t=localStorage.getItem('bos-theme');if(!t){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${hanken.variable} ${fraunces.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
