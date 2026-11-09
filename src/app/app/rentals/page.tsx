"use client";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { Page } from "@/components/shell/Page";
import { YourAgentsNav } from "@/components/shell/SubNav";
import { RentalsView } from "@/components/market/RentalsView";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";

// Everything the signed-in user rents.
export default function RentalsPage() {
  return (
    <Page title="Rented" note="agents you rent by the week" width="wide" above={<YourAgentsNav />}>
      {privyAppId() ? <SignedIn /> : <p>Sign-in isn&apos;t set up here.</p>}
    </Page>
  );
}

function SignedIn() {
  const { ready, authenticated } = usePrivy();
  const api = useApi();
  if (ready && authenticated) return <RentalsView load={api.listRentals} />;
  return (
    <p>
      <Link href="/login?next=%2Fapp%2Frentals" aria-disabled={!ready}>
        Sign in
      </Link>{" "}
      to see what you rent.
    </p>
  );
}
