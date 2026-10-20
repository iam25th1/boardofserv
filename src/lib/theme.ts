"use client";
import { useCallback, useEffect, useState } from "react";
import type { ThemeName } from "@/design/palette";
import { THEME_KEY } from "./theme-init";

// Dark first. With no stored choice the page follows the system through
// prefers-color-scheme in tokens.css. Picking a theme sets data-theme on the
// root and remembers it; storage is wrapped so a private window never throws.

const LIGHT_QUERY = "(prefers-color-scheme: light)";

export function resolvedTheme(): ThemeName {
  if (typeof document === "undefined") return "dark";
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "light" || set === "dark") return set;
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

// The theme actually on screen, kept current when the toggle or the system
// preference changes it.
export function useResolvedTheme(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>("dark");
  useEffect(() => {
    const sync = () => setTheme(resolvedTheme());
    sync();
    const media = window.matchMedia(LIGHT_QUERY);
    media.addEventListener("change", sync);
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      media.removeEventListener("change", sync);
      observer.disconnect();
    };
  }, []);
  return theme;
}

export function useTheme(): [ThemeName, () => void] {
  const theme = useResolvedTheme();
  const toggle = useCallback(() => {
    const next: ThemeName = resolvedTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage unavailable, the choice lasts for this page only
    }
  }, []);
  return [theme, toggle];
}
