"use client";
import { animate, cubicBezier, type TargetsParam } from "animejs";

// Shared motion vocabulary on anime.js v4. Motion explains what happened, it
// never decorates: no shake, no zoom punch, no blur on the page, no hue shift.
// The one allowed blur is the few pixels on words dusting in.
//
// Every tween names both ends. A "from" alone reads its end from the element,
// so an element caught mid animation (React strict mode mounts twice in
// development) would end where it started: invisible.
//
// prefers-reduced-motion turns every animation off. Each helper here, and each
// component that drives its own timeline, checks it first and leaves elements
// in their final state instead of animating.

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(REDUCED_MOTION).matches;
}

// Eases from the chalk mockup, shared so CSS and JS motion feel like one thing.
export const ease = {
  // Things arriving: quick out, soft landing.
  arrive: cubicBezier(0.2, 0.8, 0.2, 1),
  // A chalk stroke being drawn.
  draw: cubicBezier(0.3, 0.7, 0.2, 1),
  // The thinking scribble: slow start, confident finish.
  scribble: cubicBezier(0.4, 0.1, 0.3, 1),
  // A node filling in: a small overshoot, like a dot pressed onto the board.
  press: cubicBezier(0.2, 1.6, 0.4, 1),
};

// Chalk dust settling: the fade with a light blur used on words and values.
export const dustIn = {
  opacity: { from: 0, to: 1 },
  filter: { from: "blur(3px)", to: "blur(0px)" },
};

// A message, card or panel arriving: a small rise and fade in.
export function animateEnter(targets: TargetsParam, distance = 8): void {
  if (prefersReducedMotion()) return;
  animate(targets, { opacity: { from: 0, to: 1 }, translateY: { from: distance, to: 0 }, duration: 350, ease: ease.arrive });
}

// A popover or menu opening just under its trigger.
export function animateDrop(targets: TargetsParam): void {
  if (prefersReducedMotion()) return;
  animate(targets, { opacity: { from: 0, to: 1 }, translateY: { from: -4, to: 0 }, duration: 160, ease: "out(2)" });
}

// A control appearing to offer an action, for example jump to latest.
export function animatePop(targets: TargetsParam): void {
  if (prefersReducedMotion()) return;
  animate(targets, { opacity: { from: 0, to: 1 }, translateY: { from: 4, to: 0 }, duration: 180, ease: ease.arrive });
}

// A quiet attention cue on a state change, for example credit running low.
export function animateStateChange(targets: TargetsParam): void {
  if (prefersReducedMotion()) return;
  animate(targets, { opacity: { from: 0.4, to: 1 }, duration: 500, ease: "out(2)" });
}
