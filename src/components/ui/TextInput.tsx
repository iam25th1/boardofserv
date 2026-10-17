"use client";
import * as React from "react";
import styles from "./TextInput.module.css";

export type TextInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, type, ...rest },
  ref
) {
  const classes = [styles.input, className ?? ""].filter(Boolean).join(" ");
  return <input ref={ref} type={type ?? "text"} className={classes} {...rest} />;
});
