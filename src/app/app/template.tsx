"use client";
import { useLayoutEffect, useRef } from "react";
import { animatePageIn } from "@/lib/motion";

// Each move inside the app brings the page in with a calm fade and a few
// pixels of rise (nothing with reduced motion). The shell around it stays
// still.
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) animatePageIn(ref.current);
  }, []);
  return (
    <div ref={ref} className="page-in">
      {children}
    </div>
  );
}
