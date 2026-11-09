"use client";
import { useMemo } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { Page } from "@/components/shell/Page";
import { SafetyAdmin, type SafetyAdminApi } from "@/components/admin/SafetyAdmin";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";

// The admin's safety page, for the users named in ADMIN_USER_IDS.
export default function AdminSafetyPage() {
  return (
    <Page title="Safety" note="reviews, costs, freezes and reports" width="wide">
      {privyAppId() ? <SignedIn /> : <p>Sign-in isn&apos;t set up here.</p>}
    </Page>
  );
}

function SignedIn() {
  const { ready, authenticated } = usePrivy();
  const api = useApi();
  const safetyApi = useMemo<SafetyAdminApi>(() => ({ load: api.getAdminSafety }), [api]);
  if (ready && authenticated) return <SafetyAdmin api={safetyApi} />;
  return (
    <p>
      <Link href="/login?next=%2Fapp%2Fadmin%2Fsafety">Sign in</Link> to see this page.
    </p>
  );
}
