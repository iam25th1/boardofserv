"use client";
import { useEffect, useState } from "react";

// Privy loads its sign-in from its own site. A blocker (Brave's shields, an
// ad blocker) can stop it for good, and the page would wait forever. After
// this long without Privy ready, the page says so and offers a retry.
export const PRIVY_TIMEOUT_MS = 10_000;

export function usePrivyStalled(ready: boolean, ms = PRIVY_TIMEOUT_MS): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (ready) {
      setStalled(false);
      return;
    }
    const timer = setTimeout(() => setStalled(true), ms);
    return () => clearTimeout(timer);
  }, [ready, ms]);
  return stalled && !ready;
}
