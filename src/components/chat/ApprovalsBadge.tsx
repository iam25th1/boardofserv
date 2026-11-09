"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { animatePop } from "@/lib/motion";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";
import styles from "./ApprovalsBadge.module.css";

// The top bar's count of questions the signed-in owner's agents wait on,
// linking to the list. Nothing shows while none wait.

const POLL_MS = 30_000;

export function ApprovalsBadge() {
  return privyAppId() ? <SignedIn /> : null;
}

function SignedIn() {
  const { ready, authenticated } = usePrivy();
  return ready && authenticated ? <Count /> : null;
}

function Count() {
  const api = useApi();
  const [n, setN] = useState(0);
  const ref = useRef<HTMLAnchorElement>(null);
  const before = useRef(0);
  useEffect(() => {
    let live = true;
    // A count that can't be had shows nothing, never an error.
    const look = () =>
      Promise.resolve()
        .then(() => api.countApprovals())
        .then((c) => live && setN(c), () => undefined);
    void look();
    const t = setInterval(look, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [api]);
  useEffect(() => {
    if (n > before.current && ref.current) animatePop(ref.current);
    before.current = n;
  }, [n]);
  if (!n) return null;
  return (
    <Link ref={ref} href="/approvals" className={styles.badge} aria-label={`${n} ${n === 1 ? "question waits" : "questions wait"} for your answer`}>
      <span aria-hidden="true">{n}</span> waiting
    </Link>
  );
}
