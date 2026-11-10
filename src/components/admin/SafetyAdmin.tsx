"use client";
import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { Button, SkeletonPanel, TextInput, Textarea } from "@/components/ui";
import { ReviewPanel } from "@/components/agents/ReviewPanel";
import { AuditLog } from "@/components/agents/AuditLog";
import { ReppoCredits } from "./ReppoCredits";
import { formatAmount } from "@/lib/money";
import type { AdminSafetyDTO, AuditPageDTO, FreezeDTO } from "@/lib/types";
import styles from "./SafetyAdmin.module.css";

// The admin's safety page: the queue (what the screen held and what people
// reported), freezes, model cost, and every version's code review.

export interface SafetyAdminApi {
  load: () => Promise<AdminSafetyDTO>;
  freeze?: (body: { kind: FreezeDTO["kind"]; target: string; reason: string }) => Promise<AdminSafetyDTO>;
  lift?: (id: string, reason: string) => Promise<AdminSafetyDTO>;
  audit?: (before?: string | null) => Promise<AuditPageDTO>;
  moderate?: (body: { type: "report" | "listing" | "request" | "offer" | "reppo" | "payment"; id: string; action: "approve" | "hide" | "freeze"; reason: string }) => Promise<AdminSafetyDTO>;
}

export function SafetyAdmin({ api }: { api: SafetyAdminApi }) {
  const [data, setData] = useState<AdminSafetyDTO | null | undefined>(undefined);
  const load = useCallback(() => api.load().then(setData, () => setData(null)), [api]);
  useEffect(() => {
    void load();
  }, [load]);
  if (data === undefined) return <SkeletonPanel label="Getting the safety page" lines={6} />;
  if (data === null) return <p className={styles.quiet}>This page could not load. Try again in a moment.</p>;
  return (
    <div className={styles.page}>
      <ReppoCredits r={data.reppo} />
      <section className={styles.section} aria-labelledby="queue-h">
        <h2 id="queue-h">Queue</h2>
        {data.queue.reports.length + data.queue.held.length + data.queue.blocked.length + data.queue.payments.length === 0 ? (
          <p className={styles.quiet}>Nothing waiting: no payment alerts, no open reports, the screen held nothing back, and Reppo blocked no job.</p>
        ) : (
          <ul className={styles.queue}>
            {data.queue.payments.map((p) => (
              <li key={`payment-${p.id}`}>
                <div className={styles.logHead}>
                  <span className={styles.chip}>payment alert</span>
                  <strong>{PAYMENT_ALERT_WORDS[p.kind] ?? p.kind}</strong>
                </div>
                <p>{p.message}</p>
                {typeof p.details.txHash === "string" && <p className={styles.quiet}>Transaction {p.details.txHash}</p>}
                {api.moderate && <Decide type="payment" id={p.id} moderate={api.moderate} onDone={setData} canHide={false} canFreeze={false} approveLabel="Mark looked into" />}
              </li>
            ))}
            {data.queue.blocked.map((b) => (
              <li key={`reppo-${b.id}`}>
                <div className={styles.logHead}>
                  <span className={styles.chip}>job Reppo blocked</span>
                  <strong>
                    {b.agent}, version {b.version}
                  </strong>
                  <span className={styles.quiet}>by {b.maker}</span>
                </div>
                <p>
                  Reppo scored it {b.score ?? "?"} out of 100 and advised against it: {b.reason}
                </p>
                {api.moderate && <Decide type="reppo" id={b.id} moderate={api.moderate} onDone={setData} />}
              </li>
            ))}
            {data.queue.held.map((h) => (
              <li key={`${h.type}-${h.id}`}>
                <div className={styles.logHead}>
                  <span className={styles.chip}>held {h.type}</span>
                  <strong>{h.title}</strong>
                  <span className={styles.quiet}>by {h.by}</span>
                </div>
                <p>{h.reason.startsWith("Reppo") ? h.reason : `The screen held it: ${h.reason}`}</p>
                {api.moderate && <Decide type={h.type} id={h.id} moderate={api.moderate} onDone={setData} />}
              </li>
            ))}
            {data.queue.reports.map((r) => (
              <li key={r.id}>
                <div className={styles.logHead}>
                  <span className={styles.chip}>reported {r.kind}</span>
                  <strong>{r.target}</strong>
                  <span className={styles.quiet}>by {r.by}</span>
                </div>
                <p>
                  {r.reasonWords}
                  {r.note ? `: "${r.note}"` : ""}
                </p>
                {api.moderate && <Decide type="report" id={r.id} moderate={api.moderate} onDone={setData} canHide={r.kind !== "maker"} />}
              </li>
            ))}
          </ul>
        )}
      </section>
      {api.freeze && <FreezeForm freeze={api.freeze} onDone={setData} />}
      <section className={styles.section} aria-labelledby="freezes-h">
        <h2 id="freezes-h">Freezes</h2>
        {data.freezes.length ? (
          <ol className={styles.log}>
            {data.freezes.map((f) => (
              <li key={f.id} data-lifted={f.lifted ? "true" : undefined}>
                <div className={styles.logHead}>
                  <strong>{f.target}</strong>
                  <span className={styles.chip}>{f.kind}</span>
                  <span className={styles.quiet}>
                    {f.lifted ? "lifted" : "frozen"} {new Date(f.lifted?.at ?? f.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                  </span>
                </div>
                <p>
                  Frozen by {f.by}: {f.reason}
                </p>
                {f.lifted && (
                  <p className={styles.quiet}>
                    Lifted by {f.lifted.by}: {f.lifted.reason}
                  </p>
                )}
                {!f.lifted && api.lift && <LiftButton id={f.id} lift={api.lift} onDone={setData} />}
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.quiet}>Nothing has been frozen.</p>
        )}
      </section>
      {api.audit && <AuditLog load={api.audit} view="admin" />}
      <section className={styles.section} aria-labelledby="costs-h">
        <h2 id="costs-h">Model cost this week</h2>
        {data.costs.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Runs for</th>
                <th scope="col">Calls</th>
                <th scope="col">Cost</th>
                <th scope="col">Site paid</th>
              </tr>
            </thead>
            <tbody>
              {data.costs.map((c) => (
                <tr key={c.installationId}>
                  <td>
                    {c.name} <span className={styles.quiet}>by @{c.maker}</span>
                  </td>
                  <td>@{c.owner}</td>
                  <td>{c.calls}</td>
                  <td>{formatAmount(BigInt(c.week), c.decimals)} USDC</td>
                  <td>{formatAmount(BigInt(c.sitePaid), c.decimals)} USDC</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={styles.quiet}>No agent has made a model call this week.</p>
        )}
      </section>
      <section className={styles.section} aria-labelledby="reviews-h">
        <h2 id="reviews-h">Code reviews</h2>
        {data.reviews.length ? (
          <ul className={styles.list}>
            {data.reviews.map((r) => (
              <li key={r.versionId}>
                <p className={styles.who}>
                  <strong>{r.name}</strong> version {r.version}, by @{r.maker}, {r.state === "published" ? "published" : "a draft"}
                </p>
                <ReviewPanel review={r.review} />
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.quiet}>No version has been reviewed yet.</p>
        )}
      </section>
      <Link href="/app/admin" className={styles.back}>
        Payments and accounts
      </Link>
    </div>
  );
}

const KINDS: { kind: FreezeDTO["kind"]; label: string; hint: string }[] = [
  { kind: "agent", label: "An agent", hint: "its id" },
  { kind: "version", label: "A version", hint: "its id" },
  { kind: "maker", label: "A maker", hint: "@handle" },
  { kind: "renter", label: "A renter", hint: "@handle" },
];

function FreezeForm({ freeze, onDone }: { freeze: NonNullable<SafetyAdminApi["freeze"]>; onDone: (d: AdminSafetyDTO) => void }) {
  const [kind, setKind] = useState<FreezeDTO["kind"]>("agent");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const targetId = useId();
  const reasonId = useId();
  const send = async () => {
    setBusy(true);
    setSaid(null);
    try {
      onDone(await freeze({ kind, target: target.trim(), reason: reason.trim() }));
      setTarget("");
      setReason("");
      setSaid({ text: "Frozen. What it covered is paused." });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : "It couldn't be frozen. Try again.", bad: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={styles.freeze}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <h2>Freeze</h2>
      <p className={styles.quiet}>A frozen agent, version, maker or renter can&apos;t run, be rented, publish or offer. Every freeze needs a reason and shows in the log below.</p>
      <div className={styles.kinds} role="radiogroup" aria-label="What to freeze">
        {KINDS.map((k) => (
          <label key={k.kind} data-on={kind === k.kind ? "true" : undefined}>
            <input type="radio" name="freeze-kind" checked={kind === k.kind} onChange={() => setKind(k.kind)} />
            {k.label}
          </label>
        ))}
      </div>
      <label htmlFor={targetId}>Which one ({KINDS.find((k) => k.kind === kind)!.hint})</label>
      <TextInput id={targetId} value={target} onChange={(e) => setTarget(e.target.value)} required />
      <label htmlFor={reasonId}>Why</label>
      <Textarea id={reasonId} rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} required />
      <Button type="submit" disabled={busy || !target.trim() || reason.trim().length < 3}>
        {busy ? "Freezing..." : "Freeze it"}
      </Button>
      {said && (
        <p className={styles.quiet} role={said.bad ? "alert" : "status"}>
          {said.text}
        </p>
      )}
    </form>
  );
}

function LiftButton({ id, lift, onDone }: { id: string; lift: NonNullable<SafetyAdminApi["lift"]>; onDone: (d: AdminSafetyDTO) => void }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const whyId = useId();
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Lift it
      </Button>
    );
  }
  return (
    <div className={styles.lift}>
      <label htmlFor={whyId}>Why it&apos;s lifted</label>
      <TextInput id={whyId} value={why} onChange={(e) => setWhy(e.target.value)} />
      <Button
        size="sm"
        disabled={busy || why.trim().length < 3}
        onClick={async () => {
          setBusy(true);
          try {
            onDone(await lift(id, why.trim()));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Lifting..." : "Lift the freeze"}
      </Button>
    </div>
  );
}

const PAYMENT_ALERT_WORDS: Record<string, string> = {
  low_treasury: "The treasury is low",
  missing_transfer: "A payment with no transfer",
  wrong_amount: "A transfer of the wrong amount",
  wrong_address: "A transfer to the wrong address",
  ledger: "A payment the ledger doesn't match",
  unknown_transfer: "A transfer nobody here made",
};

function Decide({
  type,
  id,
  moderate,
  onDone,
  canHide = true,
  canFreeze = true,
  approveLabel = "Approve",
}: {
  type: "report" | "listing" | "request" | "offer" | "reppo" | "payment";
  id: string;
  moderate: NonNullable<SafetyAdminApi["moderate"]>;
  onDone: (d: AdminSafetyDTO) => void;
  canHide?: boolean;
  canFreeze?: boolean;
  approveLabel?: string;
}) {
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const whyId = useId();
  const act = async (action: "approve" | "hide" | "freeze") => {
    setBusy(action);
    setSaid(null);
    try {
      onDone(await moderate({ type, id, action, reason: why.trim() }));
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };
  const ready = why.trim().length >= 3 && busy === null;
  return (
    <div className={styles.decide}>
      <label htmlFor={whyId}>Why</label>
      <TextInput id={whyId} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="A few words for the log" />
      <div className={styles.actions}>
        <Button size="sm" onClick={() => void act("approve")} disabled={!ready}>
          {busy === "approve" ? "Saving..." : approveLabel}
        </Button>
        {canHide && (
          <Button size="sm" variant="ghost" onClick={() => void act("hide")} disabled={!ready}>
            {busy === "hide" ? "Hiding..." : "Hide"}
          </Button>
        )}
        {canFreeze && (
          <Button size="sm" variant="ghost" onClick={() => void act("freeze")} disabled={!ready}>
            {busy === "freeze" ? "Freezing..." : "Freeze"}
          </Button>
        )}
      </div>
      {said && (
        <p className={styles.quiet} role="alert">
          {said}
        </p>
      )}
    </div>
  );
}
