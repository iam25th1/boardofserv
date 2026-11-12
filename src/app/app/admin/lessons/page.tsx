"use client";
import { useMemo } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { Page } from "@/components/shell/Page";
import { LessonsAdmin } from "@/components/admin/LessonsAdmin";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";

// The admin's lessons page, for the users named in ADMIN_USER_IDS.
export default function AdminLessonsPage() {
  return (
    <Page title="Lessons" note="what healing builds learned, the most common first" width="wide">
      {privyAppId() ? <SignedIn /> : <p>Sign-in isn&apos;t set up here.</p>}
    </Page>
  );
}

function SignedIn() {
  const { ready, authenticated } = usePrivy();
  const api = useApi();
  const load = useMemo(() => api.getAdminLessons, [api]);
  if (ready && authenticated) return <LessonsAdmin load={load} />;
  return (
    <p>
      <Link href="/login?next=%2Fapp%2Fadmin%2Flessons">Sign in</Link> to see this page.
    </p>
  );
}
