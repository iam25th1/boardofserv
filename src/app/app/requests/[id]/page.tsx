"use client";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { RequestPageView, type RequestPageApi } from "@/components/market/RequestPageView";
import { fetchRequest } from "@/lib/publicApi";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";

// One request and its offers, for anyone; acting on it needs sign-in.
export default function RequestPage({ params }: { params: { id: string } }) {
  if (!privyAppId()) return <Public id={params.id} />;
  return <WithSignIn id={params.id} />;
}

function Public({ id }: { id: string }) {
  const api = useMemo<RequestPageApi>(() => ({ load: () => fetchRequest(id) }), [id]);
  return <RequestPageView id={id} api={api} />;
}

function WithSignIn({ id }: { id: string }) {
  const { ready, authenticated } = usePrivy();
  const signedIn = ready && authenticated;
  const api = useApi();
  const router = useRouter();
  const pageApi = useMemo<RequestPageApi>(
    () =>
      signedIn
        ? {
            load: () => api.getRequest(id),
            meToo: (on) => api.requestAction(id, on ? "metoo" : "unmetoo"),
            close: () => api.requestAction(id, "close"),
            myAgents: async () => (await api.listAgents()).flatMap((a) => (a.testing ? [{ id: a.id, name: a.name, version: a.testing }] : [])),
            offer: (body) => api.offerAgent(id, body),
            accept: (offerId) => api.acceptOffer(offerId),
            withdraw: (offerId) => api.withdrawOffer(offerId),
            onRented: (r) => router.push(`/app/rentals/${r.id}/setup`),
          }
        : { load: () => fetchRequest(id), signIn: `/login?next=${encodeURIComponent(`/app/requests/${id}`)}` },
    [api, id, signedIn, router],
  );
  return <RequestPageView key={signedIn ? "in" : "out"} id={id} api={pageApi} />;
}
