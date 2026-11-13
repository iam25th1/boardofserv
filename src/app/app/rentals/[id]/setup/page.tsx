"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { SkeletonPanel } from "@/components/ui";
import { Page } from "@/components/shell/Page";
import { SetupFlow, type SetupApi } from "@/components/agents/SetupFlow";
import { price } from "@/components/market/BoardView";
import type { SetupShape } from "@/lib/agents/definition";
import { privyAppId } from "@/lib/privy-config";
import type { RentalDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";

// Setting up an agent the user rents: the same guided setup a maker uses
// for their own (questions, connections, sheets, rules, a test run, then
// live), given only what setting it up needs: never its code or prompts.
export default function RentalSetup() {
  // Next 16 passes params to a page as a promise; a client page reads them here.
  const params = useParams<{ id: string }>();
  if (!privyAppId()) return <Page title="Set it up">Sign-in isn&apos;t set up here.</Page>;
  return <SignedIn id={params.id} />;
}

function SignedIn({ id }: { id: string }) {
  const { ready, authenticated } = usePrivy();
  if (!ready) return <Waiting />;
  if (!authenticated) {
    return (
      <Page title="Set it up">
        <Link href={`/login?next=${encodeURIComponent(`/app/rentals/${id}/setup`)}`}>Sign in</Link> to set up the agent you rent.
      </Page>
    );
  }
  return <Setup id={id} />;
}

function Waiting() {
  return (
    <Page>
      <SkeletonPanel label="Getting your rental" lines={6} />
    </Page>
  );
}

function Setup({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [got, setGot] = useState<{ rental: RentalDTO; setup: SetupShape | null } | null | undefined>(undefined);
  useEffect(() => {
    api.getRental(id).then(setGot, () => setGot(null));
  }, [api, id]);
  const setupApi = useMemo<SetupApi>(
    () => ({
      connections: api.listConnections,
      telegramCode: api.telegramCode,
      googleStart: api.googleStart,
      connectTypeform: api.connectTypeform,
      inspectSheet: api.inspectSheet,
      install: (answers) => api.installRental(id, answers),
      control: (installationId, action) => api.controlInstallation(installationId, action),
      installation: api.getInstallation,
      job: api.getJob,
      answer: (approvalId, answer) => api.answerApproval(approvalId, answer).then(() => undefined),
    }),
    [api, id],
  );

  if (got === undefined) return <Waiting />;
  if (got === null) {
    return (
      <Page title="Nothing here" note="it may be someone else's">
        <Link href="/app/board">Back to the board</Link>
      </Page>
    );
  }
  const { rental: r, setup } = got;
  const note = `you rent it from @${r.maker}, ${BigInt(r.weeklyPrice) === 0n ? "free" : `${price(r.weeklyPrice, r.decimals)} a week`}`;
  if (!setup) {
    return (
      <Page title={r.name} note={note}>
        <p>
          {r.status === "ended" ? "This rental has ended." : "It's set up."}{" "}
          <Link href={`/app/rentals/${r.id}`}>Open it</Link>
        </p>
      </Page>
    );
  }
  return (
    <Page title={`Set up ${r.name}`} note={note}>
      <SetupFlow
        agentId={`rental:${r.id}`}
        setup={setup}
        defaults={{}}
        api={setupApi}
        returnTo={`/app/rentals/${r.id}/setup`}
        onDone={() => router.push(`/app/rentals/${r.id}`)}
      />
    </Page>
  );
}
