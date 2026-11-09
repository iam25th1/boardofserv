"use client";
export const dynamic = "force-dynamic";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { createScope, createTimeline, stagger, svg, utils } from "animejs";
import { Button } from "@/components/ui";
import { Wordmark } from "@/components/chat/Wordmark";
import { SignInStalled } from "@/components/SignInStalled";
import { SignInUnset } from "@/components/SignInUnset";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import { privyAppId } from "@/lib/privy-config";
import { usePrivyStalled } from "@/lib/usePrivyStalled";
import styles from "./login.module.css";

// Where sign-in may send someone back to: only our own helper pages, the
// board, the wallet and the admin page, never another site.
const SAFE_NEXT = /^\/(h\/[a-z0-9-]+|board|wallet|admin)$/;

export default function LoginPage() {
  // No Privy app id means there is nothing to sign in with.
  if (!privyAppId()) return <SignInUnset />;
  return <SignIn />;
}

function SignIn() {
  const { ready, authenticated, login } = usePrivy();
  const router = useRouter();
  const root = useRef<HTMLElement>(null);
  const stalled = usePrivyStalled(ready);

  useEffect(() => {
    if (!ready || !authenticated) return;
    // A helper's page or the board sends people here with ?next= to come back.
    const next = new URLSearchParams(window.location.search).get("next");
    router.replace(next && SAFE_NEXT.test(next) ? next : `/chat${window.location.search}`);
  }, [ready, authenticated, router]);

  // Same arrival as the empty chat: the line rises, the chalk arrow is drawn,
  // the rest follows on a stagger.
  useLayoutEffect(() => {
    const scope = createScope({ root, mediaQueries: { reduce: REDUCED_MOTION } }).add((self) => {
      const reduce = Boolean(self?.matches.reduce);
      const arrow = svg.createDrawable("[data-arrow] path", 0, reduce ? 1 : 0);
      if (reduce) return;
      utils.set(["h1", "[data-note]", "[data-rise]"], { opacity: 0 });
      createTimeline({ defaults: { ease: ease.arrive } })
        .add("h1", { opacity: { from: 0, to: 1 }, translateY: { from: 10, to: 0 }, duration: 420 })
        .add(arrow, { draw: ["0 0", "0 1"], duration: 600, ease: ease.draw }, "-=180")
        .add("[data-note]", { opacity: { from: 0, to: 1 }, duration: 360 }, "<<+=120")
        .add("[data-rise]", { opacity: { from: 0, to: 1 }, translateY: { from: 8, to: 0 }, duration: 380, delay: stagger(70) }, "-=240");
    });
    return () => scope.revert();
  }, []);

  return (
    <main className={styles.page} ref={root}>
      <div className={styles.col}>
        <Wordmark size="lg" />
        <h1 className={styles.headline}>Build an agent by describing it</h1>
        <div className={styles.scrawl} aria-hidden="true">
          <svg viewBox="0 0 70 34" className="chalky" data-arrow>
            <path d="M4 6c14 22 34 26 58 18M54 16l8 8-11 3" />
          </svg>
          <span data-note>just your email</span>
        </div>
        <p className={styles.sub} data-rise>
          Tell boardofserv what you want to automate in plain English, and it builds the agent for you on OpenServ.
        </p>
        <div data-rise>
          {stalled ? (
            <SignInStalled align="start" />
          ) : (
            <Button onClick={login} disabled={!ready}>
              Continue with email
            </Button>
          )}
        </div>
        <p className={styles.fineprint} data-rise>
          You sign in with an email code. No wallet or crypto knowledge needed.
        </p>
      </div>
    </main>
  );
}
