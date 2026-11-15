import type { Metadata } from "next";
import { helperPage } from "@/lib/helpers";
import { shareMetadata } from "@/lib/shareMeta";

// A published helper's page, as a shared link shows it: its name and what
// it does, with the beta's card. A helper that isn't there, or was taken
// down (or a database that can't answer), gets the board's own words.

export const dynamic = "force-dynamic";

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const path = `/h/${encodeURIComponent(params.slug)}`;
  const fallback = shareMetadata({ title: "A helper on boardofserv", description: "A small helper on the boardofserv board: give it something and it answers. A beta, on test USDC.", path });
  try {
    const page = await helperPage(params.slug);
    if (!page || !("helper" in page)) return fallback;
    const { name, description } = page.helper;
    const does = description.length > 180 ? `${description.slice(0, 177).trimEnd()}...` : description;
    return shareMetadata({ title: `${name} on boardofserv`, description: `${does} A beta, on test USDC.`, path });
  } catch {
    return fallback;
  }
}

export default function HelperLayout({ children }: { children: React.ReactNode }) {
  return children;
}
