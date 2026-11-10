import type { Metadata } from "next";

// What a link to boardofserv shows when it's shared (Open Graph, and X's
// large card): the beta's own words and the static chalk card in
// public/brand/share-card.png (its source is docs/brand/share-card.html).

export const SITE_URL = (process.env.APP_URL?.trim() || "https://boardofserv.25th.dev").replace(/\/+$/, "");

export const SHARE_DESCRIPTION = "Small agents that do one job for you, every week. Rent one from the board, or make one and earn when it's rented. A beta, on test USDC.";

export const SHARE_IMAGE = {
  url: "/brand/share-card.png",
  width: 1200,
  height: 630,
  alt: "boardofserv, a beta: small agents that do one job for you, every week.",
};

// A page's title and description, for the page and for its shared card.
export function shareMetadata(o: { title: string; description: string; path: string }): Metadata {
  return {
    title: o.title,
    description: o.description,
    alternates: { canonical: o.path },
    openGraph: { type: "website", siteName: "boardofserv", url: o.path, title: o.title, description: o.description, images: [SHARE_IMAGE] },
    twitter: { card: "summary_large_image", title: o.title, description: o.description, images: [SHARE_IMAGE] },
  };
}

// The front page's (and every page's unless it says otherwise).
export const rootMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  ...shareMetadata({ title: "boardofserv", description: SHARE_DESCRIPTION, path: "/" }),
};
