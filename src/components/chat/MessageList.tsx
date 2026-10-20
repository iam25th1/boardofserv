"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Message, type MessageView } from "./Message";
import { Thinking } from "./Thinking";
import { Button } from "@/components/ui";
import { ArrowDownIcon } from "@/components/icons";
import { animatePop } from "@/lib/motion";
import styles from "./MessageList.module.css";

export interface StreamingView {
  key: string;
  content: string;
  source?: string | null;
  sourceLabel?: string | null;
}

interface Props {
  messages: MessageView[];
  streaming: StreamingView | null;
  error: string | null;
  busy: boolean;
  onRetry?: () => void;
  onRegenerate?: () => void;
  onEdit?: (id: string, content: string) => void;
  footer?: React.ReactNode;
}

export function MessageList({ messages, streaming, error, busy, onRetry, onRegenerate, onEdit, footer }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const jumpRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const checkBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(gap < 80);
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Stay pinned to the bottom while content grows, unless the user scrolled up.
  useEffect(() => {
    if (atBottom) scrollToBottom(false);
  }, [messages, streaming?.content, atBottom, scrollToBottom]);

  useEffect(() => {
    if (!atBottom && jumpRef.current) animatePop(jumpRef.current);
  }, [atBottom]);

  const lastUserId = [...messages].reverse().find((m) => m.role === "user")?.id;
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <div className={styles.wrap}>
      <div className={styles.scroller} ref={scroller} onScroll={checkBottom} role="log" aria-live="polite" aria-label="Conversation">
        <div className={styles.column}>
          {/* One keyed list, so a streamed reply settles in place when it is done. */}
          {[
            ...messages.map((m) => (
              <Message
                key={m.clientKey ?? m.id}
                message={m}
                canEdit={!busy && m.role === "user" && m.id === lastUserId}
                canRegenerate={!busy && m.role === "assistant" && m.id === lastAssistantId && !streaming}
                onRegenerate={onRegenerate}
                onEdit={(content) => onEdit?.(m.id, content)}
              />
            )),
            // Waiting before the first token: the scribble. Then the reply.
            streaming &&
              (streaming.content === "" ? (
                <Thinking key="thinking" />
              ) : (
                <Message
                  key={streaming.key}
                  message={{ id: streaming.key, role: "assistant", content: streaming.content, source: streaming.source, sourceLabel: streaming.sourceLabel }}
                  streaming
                />
              )),
          ]}
          {error && (
            <div className={styles.error} role="alert">
              <p className={styles.errorText}>{error}</p>
              {onRetry && (
                <Button variant="ghost" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              )}
            </div>
          )}
          {footer}
        </div>
      </div>
      {!atBottom && (
        <div className={styles.jump} ref={jumpRef}>
          <Button variant="ghost" size="sm" onClick={() => scrollToBottom(true)}>
            <ArrowDownIcon /> Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}
