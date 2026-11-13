"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Tooltip } from "@/components/ui";
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
  // While the agent's steps are worked out, built, tried or fixed: Stop
  // stops that work, and the maker can still type.
  onStopWork?: () => void;
  // The agent sketch dock, drawn on top of the input inside the same box.
  dock?: React.ReactNode;
  // A quiet line under the box: messages left today, or why it is paused.
  notice?: string | null;
  placeholder?: string;
}

const MAX_H = 180;

export function Composer({ conversationKey, busy, disabled, prefill, prefillNonce, onSend, onStop, onStopWork, dock, notice, placeholder }: Props) {
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
    <div className={styles.composer}>
      <div className={styles.col}>
        <div className={styles.box} data-disabled={disabled ? "true" : "false"}>
          {dock}
          <form
            className={styles.input}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <textarea
              ref={area}
              className={styles.area}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={disabled}
              rows={1}
              placeholder={placeholder ?? (disabled ? "Finish signing in to start" : "Describe what you want an agent to do")}
              aria-label="Message boardofserv"
              data-composer-input
            />
            {onStopWork && !busy && (
              <Tooltip label="Stop">
                <button type="button" className={styles.send} aria-label="Stop working on the steps" onClick={onStopWork}>
                  <StopIcon />
                </button>
              </Tooltip>
            )}
            {busy ? (
              <Tooltip label="Stop">
                <button type="button" className={styles.send} aria-label="Stop generating" onClick={onStop}>
                  <StopIcon />
                </button>
              </Tooltip>
            ) : (
              <Tooltip label="Send">
                <button type="submit" className={styles.send} aria-label="Send message" disabled={!text.trim() || disabled}>
                  <SendIcon />
                </button>
              </Tooltip>
            )}
          </form>
        </div>
        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
        <p className={styles.foot}>
          <span className={styles.keys}>Enter to send, Shift and Enter for a new line. </span>
          Runs on SERV Reasoning.
        </p>
      </div>
    </div>
  );
}
