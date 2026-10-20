"use client";
import { useTheme } from "@/lib/theme";
import styles from "./ThemeToggle.module.css";

// Names the theme you would switch to, like the mockup: "Light" on slate,
// "Dark" on the whiteboard. The choice is remembered (see lib/theme).
export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const next = theme === "dark" ? "Light" : "Dark";
  return (
    <button type="button" className={styles.theme} onClick={toggle} aria-label={`Switch to ${next.toLowerCase()} theme`}>
      {next}
    </button>
  );
}
