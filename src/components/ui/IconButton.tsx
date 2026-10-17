"use client";
import * as React from "react";
import styles from "./IconButton.module.css";

type Variant = "ghost" | "quiet";
type Size = "sm" | "md";

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  label: string;
  variant?: Variant;
  size?: Size;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = "quiet", size = "md", className, type, children, ...rest },
  ref
) {
  const classes = [styles.iconButton, styles[variant], styles[size], className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button ref={ref} type={type ?? "button"} aria-label={label} className={classes} {...rest}>
      {children}
    </button>
  );
});
