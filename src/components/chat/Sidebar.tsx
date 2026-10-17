"use client";
import { forwardRef } from "react";
import type { ConversationDTO } from "@/lib/types";
import { Button, IconButton, Menu, TextInput } from "@/components/ui";
import { Wordmark } from "./Wordmark";
import { PlusIcon, SearchIcon, EditIcon, TrashIcon, ChevronDownIcon } from "@/components/icons";
import styles from "./Sidebar.module.css";

interface Props {
  conversations: ConversationDTO[];
  activeId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenShortcuts: () => void;
  footer: React.ReactNode;
}

function groupOf(updatedAt: string): "Today" | "This week" | "Earlier" {
  const now = Date.now();
  const then = new Date(updatedAt).getTime();
  const days = (now - then) / 86_400_000;
  if (days < 1 && new Date(updatedAt).getDate() === new Date().getDate()) return "Today";
  if (days < 7) return "This week";
  return "Earlier";
}

const ORDER = ["Today", "This week", "Earlier"] as const;

export const Sidebar = forwardRef<HTMLInputElement, Props>(function Sidebar(
  { conversations, activeId, query, onQuery, onNew, onSelect, onRename, onDelete, onOpenShortcuts, footer },
  searchRef,
) {
  const filtered = conversations.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = ORDER.map((g) => ({ group: g, items: filtered.filter((c) => groupOf(c.updatedAt) === g) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <nav className={styles.rail} aria-label="Conversations">
      <div className={styles.head}>
        <Wordmark />
        <Button onClick={onNew} fullWidth>
          <PlusIcon /> New conversation
        </Button>
        <div className={styles.search}>
          <SearchIcon />
          <TextInput
            ref={searchRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
        </div>
      </div>

      <div className={styles.list}>
        {groups.length === 0 && <p className={styles.empty}>No conversations yet.</p>}
        {groups.map(({ group, items }) => (
          <div key={group} className={styles.group}>
            <h2 className={styles.groupLabel}>{group}</h2>
            <ul>
              {items.map((c) => (
                <li key={c.id} className={styles.item} data-active={c.id === activeId ? "true" : "false"}>
                  <button type="button" className={styles.itemBtn} onClick={() => onSelect(c.id)}>
                    <span className={styles.title}>{c.title}</span>
                  </button>
                  <div className={styles.itemMenu}>
                    <Menu
                      button={
                        <IconButton label={`Options for ${c.title}`} size="sm" variant="quiet">
                          <ChevronDownIcon size={16} />
                        </IconButton>
                      }
                      items={[
                        { label: "Rename", icon: <EditIcon />, onSelect: () => onRename(c.id) },
                        { label: "Delete", icon: <TrashIcon />, danger: true, onSelect: () => onDelete(c.id) },
                      ]}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className={styles.foot}>
        <button type="button" className={styles.shortcuts} onClick={onOpenShortcuts}>
          Keyboard shortcuts
        </button>
        {footer}
      </div>
    </nav>
  );
});
