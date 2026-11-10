"use client";
import { useLayoutEffect, useRef } from "react";
import { staggerIn } from "./motion";

// Once what a list waits for has loaded, its [data-enter] items ease in
// one after another, the first time only (not on every refresh).
export function useStaggerIn<T extends HTMLElement>(ready: boolean): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    staggerIn(ref.current);
  }, [ready]);
  return ref;
}
