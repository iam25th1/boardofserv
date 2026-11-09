"use client";
import { useEffect, useRef, useState } from "react";
import { animateOut } from "./motion";

// Keeps something on screen long enough to animate out: `shown` follows
// `open`, but turns false only after the element at `ref` has faded away.
export function usePresence<T extends HTMLElement>(open: boolean): { shown: boolean; ref: React.RefObject<T> } {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setShown(true);
      return;
    }
    let live = true;
    void animateOut(ref.current).then(() => live && setShown(false));
    return () => {
      live = false;
    };
  }, [open]);
  return { shown: open || shown, ref };
}
