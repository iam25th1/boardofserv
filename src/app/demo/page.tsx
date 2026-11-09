export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import { qrPath } from "@/lib/qr";
import { DemoHarness } from "./DemoHarness";
import { DemoPayments } from "./DemoPayments";

const DEMO_TREASURY = "0x7Ea5C0fFee2B6f4E3c9A1d0B8e7F6a5C4d3B2a19";

// A development-only harness that renders the real chat components with seeded
// data, so the designed UI can be reviewed and screenshotted without a live
// email login. It is not part of the product and returns 404 in production.
export default function DemoPage({ searchParams }: { searchParams: { state?: string; balance?: string; menu?: string; agents?: string; chips?: string; repeat?: string; sketch?: string; backup?: string; sketching?: string; pay?: string; left?: string } }) {
  if (process.env.NODE_ENV === "production") notFound();
  // ?pay=wallet and ?pay=admin show the payment pages with canned data.
  if (searchParams.pay === "wallet" || searchParams.pay === "admin") return <DemoPayments view={searchParams.pay} qr={qrPath(DEMO_TREASURY)} treasury={DEMO_TREASURY} />;
  return (
    <DemoHarness
      state={searchParams.state ?? "convo"}
      balance={searchParams.balance === "low" ? "low" : "ok"}
      menuOpen={searchParams.menu === "1"}
      agentsOpen={searchParams.agents === "1"}
      chips={searchParams.chips === "1"}
      sketchMode={searchParams.sketch}
      backup={searchParams.backup === "1"}
      sketching={searchParams.sketching === "1"}
      // ?left=7 shows the composer's messages-left line, ?left=0 the day used up, ?left=paused the site's limit.
      limit={searchParams.left === "paused" ? "paused" : searchParams.left !== undefined && /^\d+$/.test(searchParams.left) ? Number(searchParams.left) : null}
      repeat={Math.min(20, Math.max(1, Number(searchParams.repeat) || 1))}
    />
  );
}
