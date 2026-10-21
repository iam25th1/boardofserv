"use client";
import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useMemo } from "react";
import type { AccountDTO, ChatEvent, ConversationDTO, MessageDTO, SketchDTO } from "./types";

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
      getConversation: (id: string) => json<{ messages: MessageDTO[]; sketch: SketchDTO | null }>(`/api/conversations/${id}/messages`),
      getAccount: () => json<AccountDTO>("/api/account"),
      linkStart: (address: string) => json<{ message: string }>("/api/openserv/link/start", { method: "POST", body: JSON.stringify({ address }) }),
      linkFinish: (address: string, message: string, signature: string) =>
        json<{ ok: boolean; openservUserId: string }>("/api/openserv/link/finish", { method: "POST", body: JSON.stringify({ address, message, signature }) }),

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
            const reader = res.body.getReader();
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
                on({ type: ev, ...JSON.parse(data) } as ChatEvent);
              }
            }
          } catch (err) {
            if (!controller.signal.aborted) on({ type: "error", message: "The connection dropped. You can retry." });
          }
        })();
        return () => controller.abort();
      },
    };
  }, [authed]);
}
