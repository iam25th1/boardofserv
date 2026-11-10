"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import styles from "./ConnectionsView.module.css";

// Connecting Google: off to Google's own consent screen, and back to the
// page this started from. boardofserv asks for your sheets (to read and
// write the ones you give an agent) and your email address (to show which
// account is connected). Right before it, the notice Google asks apps to
// show: what is used, where it goes, and that it goes nowhere else.

export function GoogleConnect({ start, returnTo = "/app/connections" }: { start: (returnTo: string) => Promise<{ url: string }>; returnTo?: string }) {
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
      <p className={styles.quiet}>
        Google will ask you to let boardofserv see and edit your Google Sheets, and see your email address (to show which account is connected).
        Agents only reach the tabs you give each of them, only for the jobs you set. The rows a job reads go to SERV Reasoning, the AI model that makes
        the agent&apos;s decisions, only for that job, and stay in the job&apos;s log for you. Nothing from Google is used for anything else, shown to
        other people, or used to train AI models. More on <Link href="/privacy">Your data</Link>.
      </p>
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
