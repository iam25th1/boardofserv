"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { privyAppId } from "@/lib/privy-config";
import type { AccountDTO } from "@/lib/types";
import { useApi } from "@/lib/useApi";

// The signed-in account, read once for the whole app shell: the account
// button, the admin link and every page that wants it. undefined while it
// loads, null signed out (or when it can't be read).

interface AccountState {
  account: AccountDTO | null | undefined;
  signedIn: boolean;
  refresh: () => Promise<void>;
  setAccount: (next: AccountDTO | null | ((a: AccountDTO | null | undefined) => AccountDTO | null | undefined)) => void;
}

const AccountCtx = createContext<AccountState>({ account: null, signedIn: false, refresh: async () => {}, setAccount: () => {} });

export function useShellAccount(): AccountState {
  return useContext(AccountCtx);
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  if (!privyAppId()) return <AccountCtx.Provider value={{ account: null, signedIn: false, refresh: async () => {}, setAccount: () => {} }}>{children}</AccountCtx.Provider>;
  return <WithPrivy>{children}</WithPrivy>;
}

function WithPrivy({ children }: { children: React.ReactNode }) {
  const { ready, authenticated } = usePrivy();
  const api = useApi();
  const [account, setAccount] = useState<AccountDTO | null | undefined>(undefined);
  const signedIn = ready && authenticated;
  const refresh = useCallback(async () => {
    if (!signedIn) return setAccount(null);
    try {
      setAccount(await api.getAccount());
    } catch {
      setAccount(null);
    }
  }, [api, signedIn]);
  useEffect(() => {
    if (!ready) return;
    void refresh();
  }, [ready, refresh]);
  // The browser's time zone is the account's: saved whenever it differs,
  // so agents' times and tests go by it, never the server's.
  useEffect(() => {
    if (!account) return;
    const zone = browserZone();
    if (zone && zone !== account.timezone) void api.setTimezone(zone).then(() => setAccount((a) => (a ? { ...a, timezone: zone } : a)), () => undefined);
  }, [account, api]);
  const value = useMemo(() => ({ account, signedIn, refresh, setAccount: setAccount as AccountState["setAccount"] }), [account, signedIn, refresh]);
  return <AccountCtx.Provider value={value}>{children}</AccountCtx.Provider>;
}

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
