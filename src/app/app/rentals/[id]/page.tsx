"use client";
import { useMemo } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { SkeletonPanel } from "@/components/ui";
import { Page } from "@/components/shell/Page";
import { RentalView, type RentalApi } from "@/components/market/RentalView";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";

// One agent the signed-in user rents: its state, money, jobs and controls.
export default function RentalPage({ params }: { params: { id: string } }) {
  if (!privyAppId()) return <Page title="Rented">Sign-in isn&apos;t set up here.</Page>;
  return <SignedIn id={params.id} />;
}

function SignedIn({ id }: { id: string }) {
  const { ready, authenticated } = usePrivy();
  if (!ready) {
    return (
      <Page width="wide">
        <SkeletonPanel label="Getting what you rent" lines={8} />
      </Page>
    );
  }
  if (!authenticated) {
    return (
      <Page title="Rented">
        <Link href={`/login?next=${encodeURIComponent(`/app/rentals/${id}`)}`}>Sign in</Link> to see what you rent.
      </Page>
    );
  }
  return <Rental id={id} />;
}

function Rental({ id }: { id: string }) {
  const api = useApi();
  const rentalApi = useMemo<RentalApi>(
    () => ({
      load: () => api.getRental(id).then((d) => d.rental),
      control: (action) => api.controlRental(id, action),
      run: (installationId, action) => api.controlInstallation(installationId, action),
      job: api.getJob,
      answer: (approvalId, answer) => api.answerApproval(approvalId, answer).then(() => undefined),
      version: (choice) => api.answerVersion(id, choice),
    }),
    [api, id],
  );
  return <RentalView id={id} api={rentalApi} />;
}
