"use client";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { RequestsView, type RequestsApi } from "@/components/market/RequestsView";
import { fetchRequests } from "@/lib/publicApi";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";

const SIGN_IN = `/login?next=${encodeURIComponent("/app/requests")}`;

// The request board, for anyone; asking and "me too" need sign-in.
export default function RequestsPage() {
  if (!privyAppId()) return <Public />;
  return <WithSignIn />;
}

function Public() {
  const api = useMemo<RequestsApi>(() => ({ load: (sort) => fetchRequests(sort) }), []);
  return <RequestsView api={api} />;
}

function WithSignIn() {
  const { ready, authenticated } = usePrivy();
  const signedIn = ready && authenticated;
  const api = useApi();
  const router = useRouter();
  const requestsApi = useMemo<RequestsApi>(
    () =>
      signedIn
        ? {
            load: (sort) => api.listRequests(sort),
            ask: (body) => api.postRequest(body),
            meToo: (id, on) => api.requestAction(id, on ? "metoo" : "unmetoo"),
            onAsked: (id) => router.push(`/app/requests/${id}`),
          }
        : { load: (sort) => fetchRequests(sort), signIn: SIGN_IN },
    [api, signedIn, router],
  );
  return <RequestsView key={signedIn ? "in" : "out"} api={requestsApi} />;
}
