export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import { DemoHarness } from "./DemoHarness";

// A development-only harness that renders the real chat components with seeded
// data, so the designed UI can be reviewed and screenshotted without a live
// email login. It is not part of the product and returns 404 in production.
export default function DemoPage({ searchParams }: { searchParams: { state?: string; balance?: string; menu?: string; drawer?: string } }) {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <DemoHarness
      state={searchParams.state ?? "convo"}
      balance={searchParams.balance === "low" ? "low" : "ok"}
      menuOpen={searchParams.menu === "1"}
      drawerOpen={searchParams.drawer === "1"}
    />
  );
}
