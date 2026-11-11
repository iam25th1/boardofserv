"use client";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import type { ConversationDTO } from "@/lib/types";
import { chatNames } from "@/lib/chatNames";
import { IconButton } from "@/components/ui";
import { EditIcon, TrashIcon, SearchIcon, UnpublishIcon, PriceIcon } from "@/components/icons";
import { animateDrop } from "@/lib/motion";
import styles from "./AgentsPill.module.css";

// The agents pill on the chat's row. The popover lists the user's chats,
// each an agent being made: one with a sketch shows the agent's name, one
// without its first message, and two that would look the same each say when
// they were started (chatNames). The pill counts exactly what the list
// holds. Ring
// states follow the mockup: dashed and spinning while a reply is in progress,
// outline for a draft, filled for live (a helper on the board), and no ring
// for a conversation with no sketch yet. Search, rename and delete moved here
// from the old sidebar; a published helper can be taken off the board here,
// and, with payments on, given a price per use.

export type RingState = "live" | "wiring" | "draft" | "none";

interface Props {
  conversations: ConversationDTO[];
  activeId: string | null;
  replyingId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onUnpublish?: (id: string) => void;
  onPrice?: (id: string) => void;
  startOpen?: boolean;
}

export interface AgentsPillHandle {
  openSearch: () => void;
}

type Group = "Today" | "This week" | "Earlier";
const GROUPS: Group[] = ["Today", "This week", "Earlier"];

function groupOf(updatedAt: string): Group {
  const then = new Date(updatedAt);
  const days = (Date.now() - then.getTime()) / 86_400_000;
  if (days < 1 && then.getDate() === new Date().getDate()) return "Today";
  if (days < 7) return "This week";
  return "Earlier";
}

const STATE_TEXT: Record<RingState, string> = { wiring: "Being sketched", live: "On the board", draft: "Draft", none: "No sketch yet" };

function countLabel(n: number): string {
  if (n === 0) return "No agents yet";
  return n === 1 ? "1 agent" : `${n} agents`;
}

export const AgentsPill = forwardRef<AgentsPillHandle, Props>(function AgentsPill(
  { conversations, activeId, replyingId, onNew, onSelect, onRename, onDelete, onUnpublish, onPrice, startOpen },
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

  const ringOf = (c: ConversationDTO): RingState =>
    c.id === replyingId ? "wiring" : c.publishedSlug ? "live" : c.sketchName ? "draft" : "none";
  const names = chatNames(conversations);
  const nameOf = (c: ConversationDTO) => names.get(c.id)?.name ?? c.title;
  const detailOf = (c: ConversationDTO) => names.get(c.id)?.detail ?? null;
  const filtered = conversations.filter((c) => nameOf(c).toLowerCase().includes(query.trim().toLowerCase()));
  const groups = GROUPS.map((group) => ({ group, items: filtered.filter((c) => groupOf(c.updatedAt) === group) })).filter(
    (g) => g.items.length > 0,
  );

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
        <div className={styles.list}>
          {conversations.length > 0 && filtered.length === 0 && <p className={styles.none}>Nothing matches that.</p>}
          {groups.map(({ group, items }) => (
            <section key={group} aria-label={group}>
              <h2 className={styles.group}>{group}</h2>
              <ul>
                {items.map((c) => {
                  const state = ringOf(c);
                  return (
                    <li key={c.id} className={styles.row}>
                      <button
                        type="button"
                        className={styles.ag}
                        data-state={state}
                        aria-current={c.id === activeId ? "true" : undefined}
                        onClick={() => {
                          close(true);
                          onSelect(c.id);
                        }}
                      >
                        <i className={styles.ring} aria-hidden="true" />
                        <span className={styles.text}>
                          <strong>{nameOf(c)}</strong>
                          <small>{detailOf(c) ? `${STATE_TEXT[state]}, ${detailOf(c)}` : STATE_TEXT[state]}</small>
                        </span>
                      </button>
                      {/* Focus goes back to the pill first, so it returns there when the dialog closes. */}
                      <div className={styles.rowMenu}>
                        {c.publishedSlug && onPrice && (
                          <IconButton
                            label={`Set the price of ${nameOf(c)}`}
                            size="sm"
                            onClick={() => {
                              close(true);
                              onPrice(c.id);
                            }}
                          >
                            <PriceIcon />
                          </IconButton>
                        )}
                        {c.publishedSlug && onUnpublish && (
                          <IconButton
                            label={`Take ${nameOf(c)} off the board`}
                            size="sm"
                            onClick={() => {
                              close(true);
                              onUnpublish(c.id);
                            }}
                          >
                            <UnpublishIcon />
                          </IconButton>
                        )}
                        <IconButton
                          label={`Rename ${nameOf(c)}`}
                          size="sm"
                          onClick={() => {
                            close(true);
                            onRename(c.id);
                          }}
                        >
                          <EditIcon />
                        </IconButton>
                        <IconButton
                          label={`Delete ${nameOf(c)}`}
                          size="sm"
                          onClick={() => {
                            close(true);
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
            </section>
          ))}
        </div>
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
