import type { MetadataRoute } from "next";
import { palette } from "@/design/palette";
import { SHARE_DESCRIPTION } from "@/lib/shareMeta";

// The web manifest (/manifest.webmanifest), for adding boardofserv to a
// home screen: the beta's own description, the dark theme's slate, and the
// mark in public/brand (scripts/render-icons.mjs draws them). The maskable
// one keeps the mark well inside the circle a launcher's mask leaves.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "boardofserv",
    short_name: "boardofserv",
    description: SHARE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: palette.dark.slate,
    theme_color: palette.dark.slate,
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
