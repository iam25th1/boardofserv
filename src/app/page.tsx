import { redirect } from "next/navigation";
import { Wordmark } from "@/components/chat/Wordmark";
import { OpenApp } from "@/components/landing/OpenApp";
import styles from "@/components/landing/Landing.module.css";

// The public front page. (Development links like /?sketch=demo still reach
// the chat with their flag.)
export default function Landing({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  if (typeof searchParams.sketch === "string") redirect(`/app/chat?sketch=${encodeURIComponent(searchParams.sketch)}`);
  return (
    <main className={styles.page}>
      <div className={styles.col}>
        <Wordmark />
        <h1>Agents that do one job well, rented by the week.</h1>
        <OpenApp />
      </div>
    </main>
  );
}
