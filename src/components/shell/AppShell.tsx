"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useToast } from "@/components/ui";
import { AccountMenu } from "@/components/chat/AccountMenu";
import { ApprovalsBadge } from "@/components/chat/ApprovalsBadge";
import { ThemeToggle } from "@/components/chat/ThemeToggle";
import { Wordmark } from "@/components/chat/Wordmark";
import { privyAppId } from "@/lib/privy-config";
import { useApi } from "@/lib/useApi";
import { AccountProvider, useShellAccount } from "./AccountContext";
import styles from "./AppShell.module.css";

// One shell for every page of the app: the top bar (the mark, the
// places, the questions waiting for you, the theme and the account
// button) over the page. On a phone the places drop to a second row so
// nothing has to hide. The account button shows the account's initial and
// @handle; its menu holds the handle, your own SERV key, the wallet and
// connections, and Admin for admins only.

export const NAV: { href: string; label: string; match: readonly string[] }[] = [
  { href: "/app/chat", label: "Chat", match: ["/app/chat"] },
  { href: "/app/board", label: "Board", match: ["/app/board"] },
  { href: "/app/installations", label: "Your agents", match: ["/app/installations", "/app/rentals", "/app/agents", "/app/approvals", "/app/jobs", "/app/connections"] },
]; // (Requests joins with the request board.)

export const isHere = (path: string, match: readonly string[]) => match.some((m) => path === m || path.startsWith(`${m}/`));

// Asks the chat to open its keyboard shortcuts (the chat listens).
export const SHORTCUTS_EVENT = "bos:shortcuts";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AccountProvider>
      <Shell>{children}</Shell>
    </AccountProvider>
  );
}

// iOS Safari doesn't shrink the page for its keyboard: it slides the page
// up under it, and the composer jumps. The chat's shell follows the visual
// viewport instead (its height and where it starts), so the composer stays
// just above the keyboard and nothing jumps.
function useFitToVisualViewport(enabled: boolean, ref: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!enabled || !vv || !el) return;
    const fit = () => {
      el.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
      el.style.setProperty("--app-top", `${Math.round(vv.offsetTop)}px`);
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
      el.style.removeProperty("--app-h");
      el.style.removeProperty("--app-top");
    };
  }, [enabled, ref]);
}

function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? "";
  const fit = path.startsWith("/app/chat");
  const ref = useRef<HTMLDivElement>(null);
  useFitToVisualViewport(fit, ref);
  return (
    // The chat fills the window exactly, its composer at the bottom; other
    // pages scroll.
    <div className={styles.shell} data-fit={fit ? "true" : undefined} ref={ref}>
      <header className={styles.bar}>
        <div className={styles.row}>
          <Link href="/" className={styles.home} aria-label="boardofserv, the front page">
            <Wordmark />
          </Link>
          <nav className={styles.nav} aria-label="The app">
            <Places path={path} />
          </nav>
          <div className={styles.end}>
            <ApprovalsBadge />
            <ThemeToggle />
            <Account path={path} />
          </div>
        </div>
        <nav className={styles.navPhone} aria-label="The app">
          <Places path={path} />
        </nav>
      </header>
      <div className={styles.main}>{children}</div>
    </div>
  );
}

function Places({ path }: { path: string }) {
  return (
    <ul className={styles.places}>
      {NAV.map((n) => (
        <li key={n.href}>
          <Link href={n.href} className={styles.place} aria-current={isHere(path, n.match) ? "page" : undefined}>
            {n.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Account({ path }: { path: string }) {
  if (!privyAppId()) return null;
  return <AccountButton path={path} />;
}

function AccountButton({ path }: { path: string }) {
  const { ready, logout } = usePrivy();
  const { account, signedIn, refresh, setAccount } = useShellAccount();
  const api = useApi();
  const toast = useToast();
  if (!ready) return <span className={styles.placeholder} aria-hidden="true" />;
  if (!signedIn) {
    return (
      <Link href={`/login?next=${encodeURIComponent(path || "/app/chat")}`} className={styles.signIn}>
        Sign in
      </Link>
    );
  }
  return (
    <AccountMenu
      account={account ?? null}
      onSignOut={() => void logout()}
      onOpenShortcuts={path.startsWith("/app/chat") ? () => window.dispatchEvent(new Event(SHORTCUTS_EVENT)) : undefined}
      checkHandle={api.checkHandle}
      onSaveHandle={async (handle) => {
        const saved = await api.setHandle(handle);
        setAccount((a) => a && { ...a, handle: saved.handle, handleChosen: saved.handleChosen });
      }}
      onSaveServKey={async (key) => {
        await api.setServKey(key);
        await refresh();
        toast.show({ title: "Your SERV key is in use" });
      }}
      onRemoveServKey={async () => {
        await api.removeServKey();
        await refresh();
        toast.show({ title: "Your SERV key is removed" });
      }}
    />
  );
}
