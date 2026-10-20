"use client";
export const dynamic = "force-dynamic";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { Button } from "@/components/ui";
import { Wordmark } from "@/components/chat/Wordmark";
import { SignInUnset } from "@/components/SignInUnset";
import { animateEnter } from "@/lib/motion";
import { privyAppId } from "@/lib/privy-config";
import styles from "./login.module.css";

export default function LoginPage() {
  // No Privy app id means there is nothing to sign in with.
  if (!privyAppId()) return <SignInUnset />;
  return <SignIn />;
}

function SignIn() {
  const { ready, authenticated, login } = usePrivy();
  const router = useRouter();
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ready && authenticated) router.replace("/chat");
  }, [ready, authenticated, router]);

  useEffect(() => {
    if (card.current) animateEnter(card.current, 12);
  }, []);

  return (
    <main className={styles.page}>
      <div className={styles.card} ref={card}>
        <div className={styles.mark}>
          <Wordmark size="lg" />
        </div>
        <h1 className={styles.headline}>Build an agent by describing it</h1>
        <p className={styles.sub}>
          Tell boardofserv what you want to automate in plain English, and it builds the agent for you on OpenServ.
        </p>
        <Button onClick={login} disabled={!ready} fullWidth>
          Continue with email
        </Button>
        <p className={styles.fineprint}>You sign in with an email code. No wallet or crypto knowledge needed.</p>
      </div>
    </main>
  );
}
