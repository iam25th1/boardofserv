"use client";
import * as React from "react";
import styles from "./Tooltip.module.css";

export interface TooltipProps {
  label: string;
  children: React.ReactElement;
  side?: "top" | "bottom";
}

interface TriggerProps {
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
  onFocus?: (e: React.FocusEvent) => void;
  onBlur?: (e: React.FocusEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  "aria-describedby"?: string;
}

export function Tooltip({ label, children, side = "top" }: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();

  const child = children as React.ReactElement<TriggerProps>;
  const childProps = child.props;

  const show = () => setOpen(true);
  const hide = () => setOpen(false);

  const trigger = React.cloneElement(child, {
    "aria-describedby": open ? id : childProps["aria-describedby"],
    onMouseEnter: (e: React.MouseEvent) => {
      childProps.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e: React.MouseEvent) => {
      childProps.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent) => {
      childProps.onFocus?.(e);
      show();
    },
    onBlur: (e: React.FocusEvent) => {
      childProps.onBlur?.(e);
      hide();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      childProps.onKeyDown?.(e);
      if (e.key === "Escape") hide();
    },
  });

  const bubbleClasses = [styles.bubble, side === "bottom" ? styles.bottom : styles.top].join(" ");

  return (
    <span className={styles.root}>
      {trigger}
      <span role="tooltip" id={id} className={bubbleClasses} hidden={!open}>
        {label}
      </span>
    </span>
  );
}
