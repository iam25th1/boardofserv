"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import styles from "./ConnectionsView.module.css";

// Connecting Google: off to Google's own consent screen, and back to the
// page this started from. boardofserv asks for your sheets (to read and
// write the ones you give an agent) and your email address (to show which
// account is connected).

export function GoogleConnect({ start, returnTo = "/connections" }: { start: (returnTo: string) => Promise<{ url: string }>; returnTo?: string }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const { url } = await start(returnTo);
      window.location.assign(url);
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "It couldn't start. Try again.");
      setBusy(false);
    }
  };
  return (
    <div className={styles.details}>
      <p className={styles.quiet}>Google asks you to let boardofserv see and edit your Google Sheets. Agents only ever reach the tabs you give each of them.</p>
      <div className={styles.actions}>
        <Button size="sm" onClick={() => void go()} disabled={busy}>
          {busy ? "Going to Google..." : "Connect Google"}
        </Button>
      </div>
      {said && (
        <p className={styles.said} role="status">
          {said}
        </p>
      )}
    </div>
  );
}
