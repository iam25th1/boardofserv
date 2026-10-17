"use client";
import anime from "animejs";

// Motion helpers built on anime.js. Motion explains what happened, it never
// decorates. Every helper collapses to a short opacity fade when the user asks
// for reduced motion, and none of them move the camera, shake, blur or shift
// hue.

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const EASE = "cubicBezier(0.2, 0.7, 0.2, 1)";

// A message, card or panel arriving: a small rise and fade in.
export function animateEnter(targets: anime.AnimeParams["targets"], distance = 8): void {
  if (prefersReducedMotion()) {
    anime({ targets, opacity: [0, 1], duration: 120, easing: "linear" });
    return;
  }
  anime({ targets, opacity: [0, 1], translateY: [distance, 0], duration: 220, easing: EASE });
}

// A panel or drawer opening from an edge.
export function animateSlideIn(targets: anime.AnimeParams["targets"], axis: "x" | "y" = "x", distance = 16): void {
  if (prefersReducedMotion()) {
    anime({ targets, opacity: [0, 1], duration: 120, easing: "linear" });
    return;
  }
  const from = axis === "x" ? { translateX: [-distance, 0] } : { translateY: [distance, 0] };
  anime({ targets, opacity: [0, 1], ...from, duration: 220, easing: EASE });
}

// A control appearing to offer an action, for example jump to latest.
export function animatePop(targets: anime.AnimeParams["targets"]): void {
  if (prefersReducedMotion()) {
    anime({ targets, opacity: [0, 1], duration: 120, easing: "linear" });
    return;
  }
  anime({ targets, opacity: [0, 1], scale: [0.92, 1], duration: 180, easing: EASE });
}

// A quiet attention pulse on a state change, for example balance running low.
export function animateStateChange(targets: anime.AnimeParams["targets"]): void {
  if (prefersReducedMotion()) return;
  anime({ targets, opacity: [0.4, 1], duration: 320, easing: EASE });
}
