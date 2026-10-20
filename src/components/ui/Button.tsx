"use client";
import * as React from "react";
import styles from "./Button.module.css";

type Variant = "primary" | "ghost" | "quiet" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", fullWidth = false, className, type, children, ...rest },
  ref
) {
  const classes = [
    styles.button,
    styles[variant],
    styles[size],
    fullWidth ? styles.fullWidth : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button ref={ref} type={type ?? "button"} className={classes} {...rest}>
      {children}
    </button>
  );
});
