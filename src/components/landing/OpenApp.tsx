"use client";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { privyAppId } from "@/lib/privy-config";
import styles from "./Landing.module.css";

// The landing page's way in: signed in, a plain "Open the app"; signed out,
// sign in, or look around the board first. Nobody is sent anywhere on
// their own.
export function OpenApp({ quiet = false }: { quiet?: boolean }) {
  if (!privyAppId()) return <Fallback quiet={quiet} />;
  return <WithPrivy quiet={quiet} />;
}

function WithPrivy({ quiet }: { quiet: boolean }) {
  const { ready, authenticated } = usePrivy();
  if (ready && authenticated) {
    return (
      <div className={styles.ways}>
        <Link href="/app/chat" className={styles.primary}>
          Open the app
        </Link>
        {!quiet && (
          <Link href="/app/board" className={styles.secondary}>
            Browse the board
          </Link>
        )}
      </div>
    );
  }
  return <Fallback quiet={quiet} />;
}

function Fallback({ quiet }: { quiet: boolean }) {
  return (
    <div className={styles.ways}>
      <Link href="/login" className={styles.primary}>
        Sign in
      </Link>
      {!quiet && (
        <Link href="/app/board" className={styles.secondary}>
          Browse the board
        </Link>
      )}
    </div>
  );
}
