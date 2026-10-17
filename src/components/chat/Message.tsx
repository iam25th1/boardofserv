"use client";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { Button, IconButton, Tooltip } from "@/components/ui";
import { CopyIcon, CheckIcon, RegenerateIcon, EditIcon } from "@/components/icons";
import { animateEnter } from "@/lib/motion";
import styles from "./Message.module.css";

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  sourceLabel?: string | null;
  source?: string | null;
}

interface Props {
  message: MessageView;
  streaming?: boolean;
  canEdit?: boolean;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  onEdit?: (content: string) => void;
}

export function Message({ message, streaming, canEdit, canRegenerate, onRegenerate, onEdit }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  useEffect(() => {
    if (ref.current && !streaming) animateEnter(ref.current);
    // Run once on mount; a streaming message animates when it settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            <div className={styles.bubble}>{message.content}</div>
            {canEdit && (
              <div className={styles.userActions}>
                <Tooltip label="Edit and resend">
                  <IconButton label="Edit and resend" size="sm" onClick={() => { setDraft(message.content); setEditing(true); }}>
                    <EditIcon />
                  </IconButton>
                </Tooltip>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.assistantRow} ref={ref}>
      <div className={styles.labelRow}>
        <span className={styles.who}>boardofserv</span>
        {message.sourceLabel && (
          <Tooltip label={message.source === "serv" ? "Answered by SERV Reasoning" : `Answered by ${message.sourceLabel}, a fallback model`}>
            <span className={styles.model} data-serv={message.source === "serv" ? "true" : "false"}>
              {message.sourceLabel}
            </span>
          </Tooltip>
        )}
      </div>
      <div className={styles.body}>
        <Markdown content={message.content} />
        {streaming && <span className={styles.caret} aria-hidden="true" />}
      </div>
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
  );
}
