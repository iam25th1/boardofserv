import { Wordmark } from "@/components/chat/Wordmark";
import styles from "./SignInUnset.module.css";

// Shown in place of the sign-in and chat screens when the build has no usable
// Privy app id, for example the CI build. Privy is never mounted then.
export function SignInUnset() {
  return (
    <main className={styles.page}>
      <div className={styles.col}>
        <Wordmark />
        <h1 className={styles.title}>Sign-in isn&apos;t set up</h1>
        <p className={styles.note}>no Privy app yet</p>
        <p className={styles.body}>
          Put your Privy app id in <code>NEXT_PUBLIC_PRIVY_APP_ID</code> in <code>.env.local</code>, then restart the app.
        </p>
      </div>
    </main>
  );
}
