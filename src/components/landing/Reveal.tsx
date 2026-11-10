"use client";
import { useLayoutEffect, useRef } from "react";
import { animate, utils } from "animejs";
import { ease, prefersReducedMotion } from "@/lib/motion";

// A part of a long page that eases in once, the first time it scrolls into
// view: a fade and a short rise, then it rests. What is already on screen
// (or above it, after a jump to a heading) when the page loads stays as it
// is, so nothing that was readable is hidden. With reduced motion, or no
// IntersectionObserver, everything is simply there.

export function Reveal({ as: Tag = "section", className, labelledBy, children }: { as?: "section" | "div"; className?: string; labelledBy?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof IntersectionObserver === "undefined") return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    utils.set(el, { opacity: 0, translateY: 14 });
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        animate(el, { opacity: { from: 0, to: 1 }, translateY: { from: 14, to: 0 }, duration: 520, ease: ease.arrive });
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      utils.remove(el);
      utils.set(el, { opacity: 1, translateY: 0 });
    };
  }, []);

  return (
    <Tag ref={ref as React.Ref<HTMLDivElement>} className={className} aria-labelledby={labelledBy} data-reveal="">
      {children}
    </Tag>
  );
}
