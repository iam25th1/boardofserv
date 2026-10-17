"use client";
import { useState } from "react";
import { IconButton } from "@/components/ui";
import { CopyIcon, CheckIcon } from "@/components/icons";
import styles from "./CodeBlock.module.css";

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked, leave the code selectable by hand
    }
  };
  return (
    <div className={styles.block}>
      <div className={styles.bar}>
        <span className={styles.lang}>{language || "code"}</span>
        <IconButton label={copied ? "Copied" : "Copy code"} size="sm" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </IconButton>
      </div>
      <pre className={styles.pre}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
