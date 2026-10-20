"use client";
import * as React from "react";
import styles from "./Textarea.module.css";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...rest },
  ref
) {
  const classes = [styles.textarea, className ?? ""].filter(Boolean).join(" ");
  return <textarea ref={ref} className={classes} {...rest} />;
});
