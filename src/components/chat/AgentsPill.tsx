"use client";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import type { ConversationDTO } from "@/lib/types";
import { IconButton } from "@/components/ui";
import { EditIcon, TrashIcon, SearchIcon } from "@/components/icons";
import { animateDrop } from "@/lib/motion";
import styles from "./AgentsPill.module.css";

// The agents pill in the top bar. Real agents do not exist yet, so until they
// do the popover lists the user's conversations: each one is an agent being
// sketched. Ring states follow the mockup: dashed and spinning while a reply
// is in progress, outline for a draft, filled for live (unused until agents
// can run). Search, rename and delete moved here from the old sidebar.

export type RingState = "live" | "wiring" | "draft";

interface Props {
  conversations: ConversationDTO[];
  activeId: string | null;
  replyingId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  startOpen?: boolean;
}

export interface AgentsPillHandle {
  openSearch: () => void;
}

function when(updatedAt: string): string {
  const then = new Date(updatedAt);
  const days = (Date.now() - then.getTime()) / 86_400_000;
  if (days < 1 && then.getDate() === new Date().getDate()) return "today";
  if (days < 7) return "this week";
  return "earlier";
}

function countLabel(n: number): string {
  if (n === 0) return "No agents yet";
  return n === 1 ? "1 agent" : `${n} agents`;
}

export const AgentsPill = forwardRef<AgentsPillHandle, Props>(function AgentsPill(
  { conversations, activeId, replyingId, onNew, onSelect, onRename, onDelete, startOpen },
  ref,
) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const focusSearch = useRef(false);
  const popId = useId();

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (returnFocus) pill.current?.focus();
  };

  useImperativeHandle(ref, () => ({
    openSearch() {
      focusSearch.current = true;
      setOpen(true);
      search.current?.focus();
    },
  }));

  useEffect(() => {
    if (!open) return;
    if (pop.current) animateDrop(pop.current);
    if (focusSearch.current) {
      focusSearch.current = false;
      search.current?.focus();
    }
    const onPointer = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close(false);
    };
    // Anything inside that handles Escape itself marks it handled.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) close(true);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ringOf = (c: ConversationDTO): RingState => (c.id === replyingId ? "wiring" : "draft");
  const filtered = conversations.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className={styles.agents} ref={wrap}>
      <button
        ref={pill}
        type="button"
        className={styles.pill}
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <span className={styles.tally} aria-hidden="true">
          {(conversations.length ? conversations.slice(0, 6) : [null]).map((c, i) => (
            <i key={c?.id ?? i} className={c && ringOf(c) === "live" ? styles.on : undefined} />
          ))}
        </span>
        <span>{countLabel(conversations.length)}</span>
      </button>

      <div className={styles.pop} id={popId} ref={pop} hidden={!open}>
        {conversations.length > 0 && (
          <label className={styles.search}>
            <SearchIcon size={16} />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your agents"
              aria-label="Search conversations"
            />
          </label>
        )}
        <ul className={styles.list}>
          {conversations.length > 0 && filtered.length === 0 && <li className={styles.none}>Nothing matches that.</li>}
          {filtered.map((c) => {
            const state = ringOf(c);
            return (
              <li key={c.id} className={styles.row}>
                <button
                  type="button"
                  className={styles.ag}
                  data-state={state}
                  aria-current={c.id === activeId ? "true" : undefined}
                  onClick={() => {
                    onSelect(c.id);
                    close(false);
                  }}
                >
                  <i className={styles.ring} aria-hidden="true" />
                  <span className={styles.text}>
                    <strong>{c.title}</strong>
                    <small>{state === "wiring" ? "Being sketched" : `Draft, ${when(c.updatedAt)}`}</small>
                  </span>
                </button>
                <div className={styles.rowMenu}>
                  <IconButton
                    label={`Rename ${c.title}`}
                    size="sm"
                    onClick={() => {
                      close(false);
                      onRename(c.id);
                    }}
                  >
                    <EditIcon />
                  </IconButton>
                  <IconButton
                    label={`Delete ${c.title}`}
                    size="sm"
                    onClick={() => {
                      close(false);
                      onDelete(c.id);
                    }}
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className={styles.popnew}
          onClick={() => {
            close(false);
            onNew();
          }}
        >
          + New agent
        </button>
      </div>
    </div>
  );
});
