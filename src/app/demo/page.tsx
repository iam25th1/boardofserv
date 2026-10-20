export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import { DemoHarness } from "./DemoHarness";

// A development-only harness that renders the real chat components with seeded
// data, so the designed UI can be reviewed and screenshotted without a live
// email login. It is not part of the product and returns 404 in production.
export default function DemoPage({ searchParams }: { searchParams: { state?: string; balance?: string; menu?: string; agents?: string; chips?: string; repeat?: string; sketch?: string; backup?: string } }) {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <DemoHarness
      state={searchParams.state ?? "convo"}
      balance={searchParams.balance === "low" ? "low" : "ok"}
      menuOpen={searchParams.menu === "1"}
      agentsOpen={searchParams.agents === "1"}
      chips={searchParams.chips === "1"}
      sketchMode={searchParams.sketch}
      backup={searchParams.backup === "1"}
      repeat={Math.min(20, Math.max(1, Number(searchParams.repeat) || 1))}
    />
  );
}
