"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isHere } from "./AppShell";
import styles from "./SubNav.module.css";

// The places inside one part of the app, as tabs over its pages.

export interface SubNavItem {
  href: string;
  label: string;
  match?: string[];
}

export function SubNav({ items, label }: { items: SubNavItem[]; label: string }) {
  const path = usePathname() ?? "";
  return (
    <nav className={styles.sub} aria-label={label}>
      <ul>
        {items.map((i) => (
          <li key={i.href}>
            <Link href={i.href} aria-current={isHere(path, i.match ?? [i.href]) ? "page" : undefined}>
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// Your agents: what runs for you, what you rent, what you make, what
// waits for your answer, and what they may reach.
export const YOUR_AGENTS: SubNavItem[] = [
  { href: "/app/installations", label: "Running for you", match: ["/app/installations", "/app/jobs"] },
  { href: "/app/rentals", label: "Rented" },
  { href: "/app/agents", label: "You make" },
  { href: "/app/approvals", label: "Waiting for you" },
  { href: "/app/connections", label: "Connections" },
];

export function YourAgentsNav() {
  return <SubNav items={YOUR_AGENTS} label="Your agents" />;
}
