"use client";
import { Dialog } from "@/components/ui";
import styles from "./ShortcutsDialog.module.css";

const MOD = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "Cmd" : "Ctrl";

const SHORTCUTS: [string, string][] = [
  [`${MOD} Shift O`, "New conversation"],
  [`${MOD} K`, "Search conversations"],
  [`${MOD} J`, "Focus the message box"],
  ["Enter", "Send the message"],
  ["Shift Enter", "New line"],
  ["?", "Open this panel"],
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <dl className={styles.list}>
        {SHORTCUTS.map(([keys, what]) => (
          <div className={styles.row} key={what}>
            <dt className={styles.what}>{what}</dt>
            <dd className={styles.keys}>
              {keys.split(" ").map((k) => (
                <kbd className={styles.kbd} key={k}>
                  {k}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
