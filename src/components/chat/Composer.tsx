"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton, Tooltip } from "@/components/ui";
import { SendIcon, StopIcon } from "@/components/icons";
import { loadDraft, saveDraft } from "@/lib/drafts";
import styles from "./Composer.module.css";

interface Props {
  conversationKey: string;
  busy: boolean;
  disabled?: boolean;
  prefill?: string;
  prefillNonce?: number;
  onSend: (text: string) => void;
  onStop: () => void;
}

const MAX_H = 200;

export function Composer({ conversationKey, busy, disabled, prefill, prefillNonce, onSend, onStop }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");

  // Restore any unsent draft for this conversation.
  useEffect(() => {
    setText(loadDraft(conversationKey));
  }, [conversationKey]);

  // Fill (not send) when an example prompt is tapped.
  useEffect(() => {
    if (prefillNonce === undefined) return;
    setText(prefill ?? "");
    area.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce]);

  // Grow with the text up to a limit, then scroll.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? "auto" : "hidden";
  }, [text]);

  useEffect(() => {
    saveDraft(conversationKey, text);
  }, [conversationKey, text]);

  const submit = useCallback(() => {
    const value = text.trim();
    if (!value || busy || disabled) return;
    onSend(value);
    setText("");
    saveDraft(conversationKey, "");
  }, [text, busy, disabled, onSend, conversationKey]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const coarse = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && !coarse) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={styles.dock}>
      <div className={styles.composer} data-disabled={disabled ? "true" : "false"}>
        <textarea
          ref={area}
          className={styles.area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={disabled ? "Finish signing in to start" : "Describe the agent you want to build"}
          aria-label="Message boardofserv"
          data-composer-input
        />
        <div className={styles.send}>
          {busy ? (
            <Tooltip label="Stop">
              <IconButton label="Stop generating" variant="quiet" onClick={onStop}>
                <StopIcon />
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip label="Send">
              <IconButton label="Send message" variant="quiet" onClick={submit} disabled={!text.trim() || disabled}>
                <SendIcon />
              </IconButton>
            </Tooltip>
          )}
        </div>
      </div>
      <p className={styles.hint}>
        Enter to send, Shift and Enter for a new line. boardofserv does not build anything yet, it helps you plan.
      </p>
    </div>
  );
}
