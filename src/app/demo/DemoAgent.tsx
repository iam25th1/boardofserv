"use client";
import { useEffect, useMemo, useState } from "react";
import { AgentBuilder, type BuilderApi } from "@/components/agents/AgentBuilder";
import { nextOf, type AgentDefinition } from "@/lib/agents/definition";
import type { BenchData, CodeStatus, RunEvent } from "@/lib/agents/types";
import type { AgentBuilderDTO } from "@/lib/types";

// /demo?agent=restock: the example agent's builder and test bench, without
// sign-in. Its steps and code are the ones scripts/seed-restock.ts saved;
// a run is a dry run on the server (/api/demo/agent), every tool a mock and
// every decision a recorded answer, so nothing calls a model. Save draft and
// Publish only change this page. Development only: the example is loaded
// inside a development-only branch, so a production build doesn't have it.

interface Example {
  definition: AgentDefinition;
  code: Record<string, { status: CodeStatus; source: string | null; rounds: number; note: string | null }>;
  bench: BenchData;
  builtAt: string;
}

function dto(e: Example, state: "draft" | "published" = "draft"): AgentBuilderDTO {
  return {
    agent: {
      id: "restock",
      version: 1,
      state,
      buildState: "idle",
      buildNote: null,
      steps: e.definition.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, next: nextOf(s), code: s.kind === "code" ? (e.code[s.id]?.status ?? "queued") : null })),
    },
    name: e.definition.name,
    conversationId: null,
    definition: e.definition,
    code: e.code,
    bench: e.bench,
    versions: [{ number: 1, state, createdAt: e.builtAt, publishedAt: state === "published" ? new Date().toISOString() : null }],
  };
}

async function readEvents(body: ReadableStream<Uint8Array>, on: (e: RunEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const data = /data: (.*)/.exec(f)?.[1];
      if (data) on(JSON.parse(data) as RunEvent);
    }
  }
}

export function DemoAgent() {
  const [example, setExample] = useState<Example | null>(null);
  const [data, setData] = useState<AgentBuilderDTO | null>(null);
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      void import("@/lib/agents/examples/restock.json").then((m) => {
        const e = m.default as unknown as Example;
        setExample(e);
        setData(dto(e));
      });
    }
  }, []);
  const api = useMemo<BuilderApi | null>(
    () =>
      example && {
        load: async () => dto(example),
        run: (body, on) => {
          const controller = new AbortController();
          fetch("/api/demo/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bench: body.bench }), signal: controller.signal })
            .then((res) => (res.ok && res.body ? readEvents(res.body, on) : on({ type: "end", status: "failed", reason: "The demo run could not start.", steps: 0, ms: 0, costUsd: 0, memory: {}, sheets: {} })))
            .catch(() => {
              if (!controller.signal.aborted) on({ type: "end", status: "failed", reason: "The connection dropped.", steps: 0, ms: 0, costUsd: 0, memory: {}, sheets: {} });
            });
          return () => controller.abort();
        },
        saveBench: async (bench) => {
          const next = { ...example, bench };
          setExample(next);
          return dto(next);
        },
        publish: async () => dto(example, "published"),
      },
    [example],
  );
  if (!data || !api) return <p>getting the example agent</p>;
  return <AgentBuilder initial={data} api={api} />;
}
