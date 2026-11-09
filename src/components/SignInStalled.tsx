"use client";
import { Button } from "@/components/ui";
import styles from "./SignInStalled.module.css";

export const STALLED_TEXT = "Sign-in couldn't load. If you use Brave or an ad blocker, allow this site, then try again.";

// In place of a loader that has waited too long for Privy (usePrivyStalled).
// Retry loads the page again, which is what lets Privy start once allowed.
export function SignInStalled({ onRetry = () => window.location.reload(), align = "center" }: { onRetry?: () => void; align?: "center" | "start" }) {
  return (
    <div className={styles.stalled} data-align={align} role="alert">
      <p className={styles.text}>{STALLED_TEXT}</p>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
