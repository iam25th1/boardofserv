"use client";
import * as React from "react";
import { animatePop } from "@/lib/motion";
import styles from "./Menu.module.css";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  icon?: React.ReactNode;
}

export interface MenuProps {
  button: React.ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
}

export function Menu({ button, items, align = "end" }: MenuProps) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  React.useEffect(() => {
    if (!open) return;
    if (popoverRef.current) animatePop(popoverRef.current);
    itemRefs.current[0]?.focus();
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function focusItem(index: number) {
    const count = items.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    itemRefs.current[next]?.focus();
  }

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const active = document.activeElement;
    const currentIndex = itemRefs.current.findIndex((el) => el === active);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusItem(currentIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusItem(currentIndex - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusItem(items.length - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  const popoverClasses = [styles.popover, align === "end" ? styles.end : styles.start].join(" ");

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {button}
      </button>
      {open ? (
        <div ref={popoverRef} role="menu" className={popoverClasses} onKeyDown={onMenuKeyDown}>
          {items.map((item, i) => {
            const itemClasses = [styles.item, item.danger ? styles.danger : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={`${item.label}-${i}`}
                type="button"
                role="menuitem"
                tabIndex={-1}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                className={itemClasses}
                onClick={() => {
                  item.onSelect();
                  close(true);
                }}
              >
                {item.icon ? (
                  <span className={styles.icon} aria-hidden="true">
                    {item.icon}
                  </span>
                ) : null}
                <span className={styles.label}>{item.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
