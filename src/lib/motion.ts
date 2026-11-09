"use client";
import { animate, cubicBezier, stagger, utils, type TargetsParam } from "animejs";

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

// A page arriving after a move inside the app: a calm fade and a few
// pixels of rise. No zoom.
export function animatePageIn(target: HTMLElement): void {
  if (prefersReducedMotion()) return;
  animate(target, { opacity: { from: 0, to: 1 }, translateY: { from: 6, to: 0 }, duration: 280, ease: ease.arrive });
}

// What just loaded: the container's [data-enter] children ease in one
// after another (a short stagger, capped so a long list doesn't drag).
export function staggerIn(container: HTMLElement | null, selector = "[data-enter]"): void {
  if (!container || prefersReducedMotion()) return;
  const items = [...container.querySelectorAll<HTMLElement>(selector)].slice(0, 24);
  if (!items.length) return;
  utils.set(items, { opacity: 0 });
  animate(items, { opacity: { from: 0, to: 1 }, translateY: { from: 6, to: 0 }, duration: 300, delay: stagger(40), ease: ease.arrive });
}

// A panel (a dialog, a menu) opening from the control that opened it: it
// grows from that side of itself by a few percent and fades in, so you
// can see where it came from. No zoom punch.
export function animateOpenFrom(panel: HTMLElement, opener: Element | null): void {
  if (prefersReducedMotion()) return;
  let origin = "50% 0%";
  if (opener && opener !== document.body) {
    const p = panel.getBoundingClientRect();
    const o = opener.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((o.left + o.width / 2 - p.left) / Math.max(1, p.width)) * 100));
    const y = Math.min(100, Math.max(0, ((o.top + o.height / 2 - p.top) / Math.max(1, p.height)) * 100));
    origin = `${x.toFixed(0)}% ${y.toFixed(0)}%`;
  }
  panel.style.transformOrigin = origin;
  animate(panel, { opacity: { from: 0, to: 1 }, scale: { from: 0.97, to: 1 }, duration: 220, ease: ease.arrive });
}

// The way out: a short fade and a drop of a few pixels. Resolves when it
// is gone (at once with reduced motion), so the caller can unmount it.
export function animateOut(target: HTMLElement | null): Promise<void> {
  if (!target || prefersReducedMotion()) return Promise.resolve();
  return new Promise((resolve) => {
    animate(target, { opacity: { from: 1, to: 0 }, translateY: { from: 0, to: 4 }, duration: 150, ease: "in(2)", onComplete: () => resolve() });
  });
}
