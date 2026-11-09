"use client";
import { useLayoutEffect, useRef } from "react";
import Link from "next/link";
import { createScope, createTimeline, stagger, utils } from "animejs";
import { Button } from "@/components/ui";
import { Wordmark } from "@/components/chat/Wordmark";
import { REDUCED_MOTION, ease } from "@/lib/motion";
import styles from "./Waitlist.module.css";

// What a signed-in account sees while invite-only keeps it out: on the list,
// or turned away. The board and helper pages stay open to it.
export function Waitlist({ access, email, onSignOut }: { access: "waiting" | "rejected"; email: string | null; onSignOut: () => void }) {
  const root = useRef<HTMLElement>(null);

  // The same quiet arrival as the sign-in page, and none with reduced motion.
  useLayoutEffect(() => {
    const scope = createScope({ root, mediaQueries: { reduce: REDUCED_MOTION } }).add((self) => {
      if (self?.matches.reduce) return;
      utils.set(["h1", "[data-rise]"], { opacity: 0 });
      createTimeline({ defaults: { ease: ease.arrive } })
        .add("h1", { opacity: { from: 0, to: 1 }, translateY: { from: 10, to: 0 }, duration: 420 })
        .add("[data-rise]", { opacity: { from: 0, to: 1 }, translateY: { from: 8, to: 0 }, duration: 380, delay: stagger(70) }, "-=200");
    });
    return () => scope.revert();
  }, []);

  const waiting = access === "waiting";
  return (
    <main className={styles.page} ref={root}>
      <div className={styles.col}>
        <Wordmark />
        <h1 className={styles.title}>{waiting ? "You're on the list" : "Not open to you yet"}</h1>
        <p className={styles.note} data-rise>
          invite-only for now
        </p>
        <p className={styles.body} data-rise>
          {waiting
            ? "boardofserv lets people in by hand while it is small. Your account is on the list, and it opens here once you're let in."
            : "boardofserv lets people in by hand while it is small, and this account wasn't let in."}
          {email ? ` You're signed in as ${email}.` : ""}
        </p>
        <p className={styles.body} data-rise>
          The board is open to everyone in the meantime.
        </p>
        <div className={styles.actions} data-rise>
          <Link className={styles.link} href="/board">
            See the board
          </Link>
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}
