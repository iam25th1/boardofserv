"use client";
import * as React from "react";
import { animatePop } from "@/lib/motion";
import styles from "./Toast.module.css";

type Tone = "default" | "danger";

interface ToastInput {
  title: string;
  tone?: Tone;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastContextValue {
  show: (t: ToastInput) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const DISMISS_MS = 4000;

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const idRef = React.useRef(0);
  const timers = React.useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const remove = React.useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = React.useCallback(
    (t: ToastInput) => {
      idRef.current += 1;
      const id = idRef.current;
      setToasts((list) => [...list, { ...t, id }]);
      const timer = setTimeout(() => remove(id), DISMISS_MS);
      timers.current.set(id, timer);
    },
    [remove]
  );

  React.useEffect(() => {
    const active = timers.current;
    return () => {
      active.forEach((t) => clearTimeout(t));
      active.clear();
    };
  }, []);

  const value = React.useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.viewport} role="status" aria-live="polite">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => remove(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (ref.current) animatePop(ref.current);
  }, []);

  const classes = [styles.toast, toast.tone === "danger" ? styles.danger : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={ref} className={classes}>
      <span className={styles.title}>{toast.title}</span>
      <button
        type="button"
        className={styles.dismiss}
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <span aria-hidden="true">{"×"}</span>
      </button>
    </div>
  );
}
