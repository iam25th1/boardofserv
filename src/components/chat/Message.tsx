"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate, stagger, utils } from "animejs";
import { Markdown } from "./Markdown";
import { Button, IconButton, Tooltip } from "@/components/ui";
import { CopyIcon, CheckIcon, RegenerateIcon, EditIcon } from "@/components/icons";
import { animateEnter, dustIn, prefersReducedMotion } from "@/lib/motion";
import styles from "./Message.module.css";

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  sourceLabel?: string | null;
  source?: string | null;
  // A reply that streamed in this session keeps the key it streamed under, so
  // it settles in place instead of mounting again.
  clientKey?: string;
  settled?: boolean;
}

interface Props {
  message: MessageView;
  streaming?: boolean;
  canEdit?: boolean;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  onEdit?: (content: string) => void;
}

// Words arriving in one chunk dust in together, on a light stagger that never
// spreads a chunk over more than about a fifth of a second.
const CHUNK_SPREAD_MS = 200;
const WORD_STEP_MS = 28;

function useDustInWords(body: React.RefObject<HTMLDivElement>, content: string, active: boolean) {
  const seen = useRef(0);
  // Layout effect: new words are hidden before the browser paints them.
  useLayoutEffect(() => {
    if (!active || !body.current) return;
    const all = body.current.querySelectorAll<HTMLElement>("[data-w]");
    const fresh = Array.prototype.slice.call(all, seen.current) as HTMLElement[];
    seen.current = all.length;
    if (fresh.length === 0 || prefersReducedMotion()) return;
    utils.set(fresh, { opacity: 0 });
    // One animation per arriving chunk, however many words it carries.
    animate(fresh, {
      ...dustIn,
      duration: 500,
      ease: "out(2)",
      delay: stagger(Math.min(WORD_STEP_MS, CHUNK_SPREAD_MS / fresh.length)),
    });
  }, [body, content, active]);
}

// What the model label's tooltip says, by who answered.
const SOURCE_TIP: Record<string, (label: string) => string> = {
  serv: () => "Answered by SERV Reasoning",
  fallback: (label) => `Answered by ${label}, the backup model`,
  demo: () => "A demo reply from the development build",
};

export function Message({ message, streaming, canEdit, canRegenerate, onRegenerate, onEdit }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  useEffect(() => {
    // A streamed reply arrives word by word instead, and settles in place.
    if (ref.current && !streaming && !message.settled) animateEnter(ref.current);
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useDustInWords(body, message.content, Boolean(streaming));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable, text is still selectable
    }
  };

  if (message.role === "user") {
    return (
      <div className={styles.userRow} ref={ref}>
        {editing ? (
          <div className={styles.editor}>
            <textarea
              className={styles.editArea}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Edit your message"
              rows={Math.min(8, draft.split("\n").length + 1)}
              autoFocus
            />
            <div className={styles.editActions}>
              <Button variant="ghost" size="sm" onClick={() => { setDraft(message.content); setEditing(false); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!draft.trim()}
                onClick={() => { setEditing(false); onEdit?.(draft.trim()); }}
              >
                Send
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.userGroup}>
            {canEdit && (
              <div className={styles.userActions}>
                <Tooltip label="Edit and resend">
                  <IconButton label="Edit and resend" size="sm" onClick={() => { setDraft(message.content); setEditing(true); }}>
                    <EditIcon />
                  </IconButton>
                </Tooltip>
              </div>
            )}
            <div className={styles.you}>{message.content}</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.op} ref={ref}>
      <div className={styles.body} ref={body}>
        <Markdown content={message.content} words={Boolean(streaming || message.settled)} />
        {streaming && <span className={styles.caret} aria-hidden="true" />}
      </div>
      {message.source === "fallback" && <p className={styles.note}>Answered by the backup model.</p>}
      {message.source === "demo" && <p className={styles.note}>A demo reply. No model is set up.</p>}
      <div className={styles.foot}>
        {message.sourceLabel && (
          <Tooltip label={SOURCE_TIP[message.source ?? ""]?.(message.sourceLabel) ?? `Answered by ${message.sourceLabel}`}>
            <span className={styles.model} data-serv={message.source === "serv" ? "true" : "false"}>
              {message.sourceLabel}
            </span>
          </Tooltip>
        )}
        {!streaming && (
          <div className={styles.actions}>
            <Tooltip label={copied ? "Copied" : "Copy message"}>
              <IconButton label={copied ? "Copied" : "Copy message"} size="sm" onClick={copy}>
                {copied ? <CheckIcon /> : <CopyIcon />}
              </IconButton>
            </Tooltip>
            {canRegenerate && (
              <Tooltip label="Regenerate reply">
                <IconButton label="Regenerate reply" size="sm" onClick={onRegenerate}>
                  <RegenerateIcon />
                </IconButton>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
