"use client";
import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useMemo } from "react";
import type { AccountDTO, ChatEvent, ConversationDTO, HelperEvent, MessageDTO, PublicHelperDTO, QuotaDTO, SketchDTO } from "./types";

// Every request carries the Privy access token as a bearer, which the server
// verifies. The token is the only credential the browser holds; the OpenServ
// key stays on the server.
export function useApi() {
  const { getAccessToken } = usePrivy();

  const authed = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      const token = await getAccessToken();
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      return fetch(path, { ...init, headers });
    },
    [getAccessToken],
  );

  return useMemo(() => {
    const json = async <T,>(p: string, init?: RequestInit): Promise<T> => {
      const res = await authed(p, init);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`);
      return res.json() as Promise<T>;
    };
    return {
      listConversations: () => json<{ conversations: ConversationDTO[] }>("/api/conversations").then((d) => d.conversations),
      createConversation: () => json<{ conversation: ConversationDTO }>("/api/conversations", { method: "POST" }).then((d) => d.conversation),
      renameConversation: (id: string, title: string) =>
        json<{ conversation: ConversationDTO }>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }).then((d) => d.conversation),
      deleteConversation: (id: string) => json<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),
      getConversation: (id: string) =>
        json<{ messages: MessageDTO[]; sketch: SketchDTO | null; published: PublicHelperDTO | null }>(`/api/conversations/${id}/messages`),
      // Already on the board (409) comes back as the helper that is there.
      publishHelper: async (body: { conversationId: string; description: string; inputHint: string }): Promise<PublicHelperDTO> => {
        const res = await authed("/api/helpers", { method: "POST", body: JSON.stringify(body) });
        const data = (await res.json().catch(() => ({}))) as { helper?: PublicHelperDTO; error?: string };
        if (data.helper && (res.ok || res.status === 409)) return data.helper;
        throw new Error(data.error ?? `Request failed (${res.status})`);
      },
      unpublishHelper: (slug: string) => json<{ ok: boolean }>(`/api/helpers/${encodeURIComponent(slug)}`, { method: "DELETE" }),
      getAccount: () => json<AccountDTO>("/api/account"),
      linkStart: (address: string) => json<{ message: string }>("/api/openserv/link/start", { method: "POST", body: JSON.stringify({ address }) }),
      linkFinish: (address: string, message: string, signature: string) =>
        json<{ ok: boolean; openservUserId: string }>("/api/openserv/link/finish", { method: "POST", body: JSON.stringify({ address, message, signature }) }),

      getQuota: () => json<{ quota: QuotaDTO }>("/api/uses").then((d) => d.quota),

      // Use a published helper once, streamed. Returns an abort function.
      runHelper(slug: string, input: string, on: (e: HelperEvent) => void): () => void {
        const controller = new AbortController();
        (async () => {
          try {
            const res = await authed(`/api/helpers/${encodeURIComponent(slug)}/use`, { method: "POST", body: JSON.stringify({ input }), signal: controller.signal });
            if (!res.ok || !res.body) {
              const body = (await res.json().catch(() => ({}))) as { error?: string; quota?: QuotaDTO };
              on({ type: "error", message: body.error ?? "The helper could not start. Try again.", quota: body.quota });
              return;
            }
            await readEvents(res.body, (type, data) => on({ type, ...data } as HelperEvent));
          } catch {
            if (!controller.signal.aborted) on({ type: "error", message: "The connection dropped. Try again." });
          }
        })();
        return () => controller.abort();
      },

      // Stream a reply. Returns an abort function for the stop button.
      sendChat(
        body: { conversationId?: string; content?: string; regenerate?: boolean; editMessageId?: string },
        on: (e: ChatEvent) => void,
      ): () => void {
        const controller = new AbortController();
        (async () => {
          try {
            const res = await authed("/api/chat", { method: "POST", body: JSON.stringify(body), signal: controller.signal });
            if (!res.ok || !res.body) {
              on({ type: "error", message: "The reply could not start. You can retry." });
              return;
            }
            await readEvents(res.body, (type, data) => on({ type, ...data } as ChatEvent));
          } catch (err) {
            if (!controller.signal.aborted) on({ type: "error", message: "The connection dropped. You can retry." });
          }
        })();
        return () => controller.abort();
      },
    };
  }, [authed]);
}

// Server-sent events from a response body, one callback per event.
async function readEvents(body: ReadableStream<Uint8Array>, on: (type: string, data: object) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const ev = /event: (.*)/.exec(frame)?.[1];
      const data = /data: (.*)/.exec(frame)?.[1];
      if (!ev || !data) continue;
      on(ev, JSON.parse(data) as object);
    }
  }
}
