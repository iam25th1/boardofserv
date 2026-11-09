"use client";
import { useRef } from "react";

// A tap that counts only when the finger didn't move: a press that turns
// into a scroll (more than a few pixels of travel) is not a choice. Mouse
// and keyboard clicks always count.

const SLOP_PX = 8;

export function useTapGuard(onTap: () => void): {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerCancel: () => void;
  onClick: (e: React.MouseEvent) => void;
} {
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  return {
    onPointerDown: (e) => {
      start.current = e.pointerType === "mouse" ? null : { x: e.clientX, y: e.clientY, moved: false };
    },
    onPointerMove: (e) => {
      const s = start.current;
      if (s && !s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP_PX) s.moved = true;
    },
    // The browser took the touch for a scroll.
    onPointerCancel: () => {
      if (start.current) start.current.moved = true;
    },
    onClick: (e) => {
      const moved = start.current?.moved ?? false;
      start.current = null;
      if (moved) {
        e.preventDefault();
        return;
      }
      onTap();
    },
  };
}
