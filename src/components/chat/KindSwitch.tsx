"use client";
import type { SketchKind } from "@/lib/sketchFields";
import styles from "./KindSwitch.module.css";

// The small kind switch on a dock: a native select dressed as a chalk pill.
// An answer helper replies once; an agent runs on its own; watcher, digest
// and helper are the older agent kinds, kept for sketches that have them.
export const KINDS: SketchKind[] = ["answer", "agent", "watcher", "digest", "helper"];

export function KindSwitch({ kind, onKind, locked = null }: { kind: SketchKind | null; onKind: (kind: SketchKind) => void; locked?: string | null }) {
  return (
    <label className={styles.kind}>
      <span className="visually-hidden">Kind</span>
      <select value={kind ?? ""} onChange={(e) => onKind(e.target.value as SketchKind)} disabled={Boolean(locked)} title={locked ?? "What kind of agent this is"}>
        {!kind && (
          <option value="" disabled>
            kind
          </option>
        )}
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
    </label>
  );
}
