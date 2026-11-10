"use client";
import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useMemo } from "react";
import type { BenchData, RunEvent } from "./agents/types";
import type { InstallAnswers } from "./agents/settingsForm";
import type { AccountDTO, AdminDTO, AdminSafetyDTO, AuditPageDTO, ConnectionDTO, AgentMessageDTO, AgentPageDTO, ApprovalDTO, AgentBuilderDTO, AgentListItemDTO, AgentSummaryDTO, BalanceDTO, PriceDTO, ChatEvent, ConversationDTO, HelperEvent, InstallationDTO, JobDTO, JobSummaryDTO, MessageDTO, PublicHelperDTO, MakerDashboardDTO, QuotaDTO, RentalDetailDTO, RentalDTO, RequestDTO, RequestPageDTO, SketchDTO, SpendingDTO, WalletDTO } from "./types";
import type { SetupShape } from "./agents/definition";
import type { DisputeList, PayeeBody } from "@/components/agents/SpendingPanel";

// When the server sends no sentence of its own: never a status code.
const SOMETHING_WRONG = "Something went wrong. Try again in a few minutes.";

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
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? SOMETHING_WRONG);
      return res.json() as Promise<T>;
    };
    return {
      // The owner's connections, and which services can be connected here.
      listConnections: () => json<{ connections: ConnectionDTO[]; available: { telegram: boolean; google: boolean } }>("/api/connections"),
      disconnect: (provider: ConnectionDTO["provider"]) => json<{ revoked: boolean | null; paused: number }>(`/api/connections?provider=${provider}`, { method: "DELETE" }),
      // A one-time code to send the bot from the chat to link.
      telegramCode: () => json<{ code: string; link: string; bot: string; expiresAt: string }>("/api/connections/telegram/code", { method: "POST" }),
      // A Google Sheet's name and tabs, opened on the owner's Google access.
      inspectSheet: (url: string) => json<{ title: string; tabs: { id: number; title: string }[] }>("/api/sheets/inspect", { method: "POST", body: JSON.stringify({ url }) }),
      // Where to go to connect Google (the browser goes there next).
      googleStart: (returnTo: string) => json<{ url: string }>("/api/connections/google/start", { method: "POST", body: JSON.stringify({ returnTo }) }),
      listConversations: () => json<{ conversations: ConversationDTO[] }>("/api/conversations").then((d) => d.conversations),
      createConversation: () => json<{ conversation: ConversationDTO }>("/api/conversations", { method: "POST" }).then((d) => d.conversation),
      renameConversation: (id: string, title: string) =>
        json<{ conversation: ConversationDTO }>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }).then((d) => d.conversation),
      setSketchKind: (id: string, kind: NonNullable<SketchDTO["kind"]>) =>
        json<{ sketch: SketchDTO }>(`/api/conversations/${id}/sketch`, { method: "PATCH", body: JSON.stringify({ kind }) }).then((d) => d.sketch),
      deleteConversation: (id: string) => json<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),
      getConversation: (id: string) =>
        json<{ messages: MessageDTO[]; sketch: SketchDTO | null; published: PublicHelperDTO | null; agent?: AgentSummaryDTO | null }>(`/api/conversations/${id}/messages`),
      // Plan the conversation's agent; it builds in the background.
      planAgent: (conversationId: string) =>
        json<{ agent: AgentSummaryDTO }>("/api/agents", { method: "POST", body: JSON.stringify({ conversationId }) }).then((d) => d.agent),
      getAgent: (id: string) => json<{ agent: AgentSummaryDTO }>(`/api/agents/${encodeURIComponent(id)}`).then((d) => d.agent),
      getAgentBuilder: (id: string) => json<{ builder: AgentBuilderDTO }>(`/api/agents/${encodeURIComponent(id)}?view=builder`).then((d) => d.builder),
      listAgents: () => json<{ agents: AgentListItemDTO[] }>("/api/agents").then((d) => d.agents),
      saveAgentBench: (id: string, bench: BenchData) =>
        json<{ builder: AgentBuilderDTO }>(`/api/agents/${encodeURIComponent(id)}/bench`, { method: "PUT", body: JSON.stringify({ bench }) }).then((d) => d.builder),
      // Put the agent on the board for rent (USDC minor units), or change it.
      setListing: (id: string, body: { weeklyPrice: string; jobFee: string; listed: boolean; modelBudget?: string; modelShare?: boolean }) =>
        json<{ builder: AgentBuilderDTO }>(`/api/agents/${encodeURIComponent(id)}/listing`, { method: "POST", body: JSON.stringify(body) }).then((d) => d.builder),
      // An agent's page on the board, as the signed-in viewer sees it (theirs,
      // or rented by them). Null when it isn't on the board.
      getAgentPage: async (id: string): Promise<AgentPageDTO | null> => {
        const res = await authed(`/api/market/agents/${encodeURIComponent(id)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(SOMETHING_WRONG);
        return ((await res.json()) as { agent: AgentPageDTO }).agent;
      },
      // Rent it: the first week is charged now. A refusal carries its status
      // (402: the balance doesn't cover it).
      rentAgent: async (id: string): Promise<RentalDTO> => {
        const res = await authed(`/api/market/agents/${encodeURIComponent(id)}/rent`, { method: "POST" });
        const data = (await res.json().catch(() => ({}))) as { rental?: RentalDTO; error?: string };
        if (res.ok && data.rental) return data.rental;
        throw Object.assign(new Error(data.error ?? SOMETHING_WRONG), { status: res.status });
      },
      listRentals: () => json<{ rentals: RentalDTO[] }>("/api/rentals").then((d) => d.rentals),
      getRental: (id: string) => json<{ rental: RentalDetailDTO; setup: SetupShape | null }>(`/api/rentals/${encodeURIComponent(id)}`),
      installRental: async (id: string, answers: InstallAnswers): Promise<InstallationDTO> => {
        const res = await authed(`/api/rentals/${encodeURIComponent(id)}/install`, { method: "POST", body: JSON.stringify(answers) });
        const data = (await res.json().catch(() => ({}))) as { installation?: InstallationDTO; error?: string; errors?: Record<string, string> };
        if (res.ok && data.installation) return data.installation;
        throw Object.assign(new Error(data.error ?? SOMETHING_WRONG), { errors: data.errors });
      },
      controlRental: async (id: string, action: "pause" | "resume" | "cancel" | "renew"): Promise<RentalDetailDTO> => {
        const res = await authed(`/api/rentals/${encodeURIComponent(id)}/control`, { method: "POST", body: JSON.stringify({ action }) });
        const data = (await res.json().catch(() => ({}))) as { rental?: RentalDetailDTO; error?: string };
        if (res.ok && data.rental) return data.rental;
        throw Object.assign(new Error(data.error ?? SOMETHING_WRONG), { status: res.status });
      },
      answerVersion: (id: string, choice: "update" | "stay") =>
        json<{ rental: RentalDetailDTO; setupAgain: boolean }>(`/api/rentals/${encodeURIComponent(id)}/version`, { method: "POST", body: JSON.stringify({ choice }) }),
      killAgent: (id: string, action: "stop" | "start", note?: string) =>
        json<{ dashboard: MakerDashboardDTO }>(`/api/agents/${encodeURIComponent(id)}/kill`, { method: "POST", body: JSON.stringify({ action, note }) }).then((d) => d.dashboard),
      getMakerDashboard: (id: string) => json<{ dashboard: MakerDashboardDTO }>(`/api/agents/${encodeURIComponent(id)}/dashboard`).then((d) => d.dashboard),
      // The request board, as the signed-in viewer sees it (their own, and
      // their "me too").
      listRequests: (sort: "wanted" | "newest") => json<{ requests: RequestDTO[] }>(`/api/requests?sort=${sort}`).then((d) => d.requests),
      myRequests: () => json<{ requests: RequestDTO[] }>("/api/requests?mine=1").then((d) => d.requests),
      postRequest: (body: { need: string; detail: string; connects: string[]; budget: string }) => json<{ id: string }>("/api/requests", { method: "POST", body: JSON.stringify(body) }),
      getRequest: async (id: string): Promise<RequestPageDTO | null> => {
        const res = await authed(`/api/requests/${encodeURIComponent(id)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(SOMETHING_WRONG);
        return (await res.json()) as RequestPageDTO;
      },
      requestAction: (id: string, action: "metoo" | "unmetoo" | "close") => json<RequestPageDTO>(`/api/requests/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action }) }),
      offerAgent: (id: string, body: { agentId: string; note: string; weeklyPrice: string; jobFee: string }) =>
        json<RequestPageDTO>(`/api/requests/${encodeURIComponent(id)}/offers`, { method: "POST", body: JSON.stringify(body) }),
      acceptOffer: async (offerId: string): Promise<RentalDTO> => {
        const res = await authed(`/api/offers/${encodeURIComponent(offerId)}`, { method: "POST", body: JSON.stringify({ action: "accept" }) });
        const data = (await res.json().catch(() => ({}))) as { rental?: RentalDTO; error?: string };
        if (res.ok && data.rental) return data.rental;
        throw Object.assign(new Error(data.error ?? SOMETHING_WRONG), { status: res.status });
      },
      withdrawOffer: (offerId: string) => json<{ ok: boolean }>(`/api/offers/${encodeURIComponent(offerId)}`, { method: "POST", body: JSON.stringify({ action: "withdraw" }) }).then(() => undefined),
      publishAgent: (id: string) => json<{ builder: AgentBuilderDTO }>(`/api/agents/${encodeURIComponent(id)}/publish`, { method: "POST" }).then((d) => d.builder),
      // Run the newest published version for real. A refusal carries the
      // answers that need another look, by field.
      installAgent: async (id: string, answers: InstallAnswers, o: { live?: boolean } = {}): Promise<InstallationDTO> => {
        const res = await authed(`/api/agents/${encodeURIComponent(id)}/installations`, { method: "POST", body: JSON.stringify({ ...answers, ...o }) });
        const data = (await res.json().catch(() => ({}))) as { installation?: InstallationDTO; error?: string; errors?: Record<string, string> };
        if (res.ok && data.installation) return data.installation;
        throw Object.assign(new Error(data.error ?? SOMETHING_WRONG), { errors: data.errors });
      },
      listInstallations: () => json<{ installations: InstallationDTO[] }>("/api/installations").then((d) => d.installations),
      // An installation's spending: allowance, payees, receipts, its limit.
      getSpending: (id: string) => json<{ spending: SpendingDTO }>(`/api/installations/${encodeURIComponent(id)}/allowance`).then((d) => d.spending),
      allowance: (id: string, body: { action: "topup" | "withdraw"; amount: string; key: string }) =>
        json<{ spending: SpendingDTO }>(`/api/installations/${encodeURIComponent(id)}/allowance`, { method: "POST", body: JSON.stringify(body) }).then((d) => d.spending),
      payees: (id: string, body: PayeeBody) => json<{ spending: SpendingDTO }>(`/api/installations/${encodeURIComponent(id)}/payees`, { method: "POST", body: JSON.stringify(body) }).then((d) => d.spending),
      // The renter's disputes, and what they can still dispute.
      listDisputes: () => json<DisputeList>("/api/disputes"),
      openDispute: (body: { kind: "payment" | "rent"; id: string; reason: string; note: string }) => json<DisputeList>("/api/disputes", { method: "POST", body: JSON.stringify(body) }),
      getInstallation: (id: string) => json<{ installation: InstallationDTO }>(`/api/installations/${encodeURIComponent(id)}`).then((d) => d.installation),
      getJob: (id: string) => json<{ job: JobDTO }>(`/api/jobs/${encodeURIComponent(id)}`).then((d) => d.job),
      listInstallationJobs: (id: string) => json<{ jobs: JobSummaryDTO[] }>(`/api/installations/${encodeURIComponent(id)}/jobs`).then((d) => d.jobs),
      listAgentJobs: (id: string) => json<{ jobs: JobSummaryDTO[] }>(`/api/agents/${encodeURIComponent(id)}/jobs`).then((d) => d.jobs),
      listApprovals: () => json<{ approvals: ApprovalDTO[] }>("/api/approvals").then((d) => d.approvals),
      countApprovals: () => json<{ pending: number }>("/api/approvals?count=1").then((d) => d.pending),
      answerApproval: (id: string, answer: string) =>
        json<{ approval: ApprovalDTO }>(`/api/approvals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ answer }) }).then((d) => d.approval),
      setPolicy: (id: string, body: { askFor: string[]; autoSpendUsdc: number }) =>
        json<{ installation: InstallationDTO }>(`/api/installations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }).then((d) => d.installation),
      setModelBudget: (id: string, modelBudget: string | null) =>
        json<{ installation: InstallationDTO }>(`/api/installations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ modelBudget }) }).then((d) => d.installation),
      controlInstallation: (id: string, action: "pause" | "resume" | "stop" | "run" | "test" | "golive") =>
        json<{ installation: InstallationDTO }>(`/api/installations/${encodeURIComponent(id)}/control`, { method: "POST", body: JSON.stringify({ action }) }).then((d) => d.installation),
      listAgentMessages: (id: string) => json<{ messages: AgentMessageDTO[] }>(`/api/installations/${encodeURIComponent(id)}/messages`).then((d) => d.messages),
      messageAgent: (id: string, text: string) =>
        json<{ message: AgentMessageDTO }>(`/api/installations/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ text }) }).then((d) => d.message),
      // Change the plan from what the maker says; it rebuilds in the background.
      fixAgent: (id: string, message: string) =>
        json<{ agent: AgentSummaryDTO }>(`/api/agents/${encodeURIComponent(id)}/fix`, { method: "POST", body: JSON.stringify({ message }) }).then((d) => d.agent),
      // One test bench run, streamed. Returns an abort function.
      runAgent(id: string, body: { dryRun: boolean; bench: BenchData }, on: (e: RunEvent) => void): () => void {
        const controller = new AbortController();
        (async () => {
          try {
            const res = await authed(`/api/agents/${encodeURIComponent(id)}/run`, { method: "POST", body: JSON.stringify(body), signal: controller.signal });
            if (!res.ok || !res.body) {
              const refused = (await res.json().catch(() => ({}))) as { error?: string };
              on({ type: "end", status: "failed", reason: refused.error ?? "The run could not start. Try again.", steps: 0, ms: 0, costUsd: 0, memory: {}, sheets: {} });
              return;
            }
            await readEvents(res.body, (_type, data) => on(data as RunEvent));
          } catch {
            if (!controller.signal.aborted) on({ type: "end", status: "failed", reason: "The connection dropped. Try again.", steps: 0, ms: 0, costUsd: 0, memory: {}, sheets: {} });
          }
        })();
        return () => controller.abort();
      },
      // Already on the board (409) comes back as the helper that is there.
      publishHelper: async (body: {
        conversationId: string;
        description: string;
        inputHint: string;
        prices?: Partial<Record<"USDC" | "SERV", string | null>>;
      }): Promise<PublicHelperDTO> => {
        const res = await authed("/api/helpers", { method: "POST", body: JSON.stringify(body) });
        const data = (await res.json().catch(() => ({}))) as { helper?: PublicHelperDTO; error?: string };
        if (data.helper && (res.ok || res.status === 409)) return data.helper;
        throw new Error(data.error ?? SOMETHING_WRONG);
      },
      unpublishHelper: (slug: string) => json<{ ok: boolean }>(`/api/helpers/${encodeURIComponent(slug)}`, { method: "DELETE" }),
      setPrices: (slug: string, prices: Partial<Record<"USDC" | "SERV", string | null>>) =>
        json<{ helper: PublicHelperDTO }>(`/api/helpers/${encodeURIComponent(slug)}/prices`, { method: "PUT", body: JSON.stringify({ prices }) }).then((d) => d.helper),
      getAccount: () => json<AccountDTO>("/api/account"),
      checkHandle: (handle: string, signal: AbortSignal) =>
        json<{ available: boolean; error?: string }>(`/api/account/handle?handle=${encodeURIComponent(handle)}`, { signal }),
      setHandle: (handle: string) =>
        json<{ handle: string; handleChosen: boolean }>("/api/account/handle", { method: "PATCH", body: JSON.stringify({ handle }) }),
      setServKey: (key: string) =>
        json<{ servKey: { last4: string } }>("/api/account/serv-key", { method: "POST", body: JSON.stringify({ key }) }).then((d) => d.servKey),
      removeServKey: () => json<{ servKey: null }>("/api/account/serv-key", { method: "DELETE" }),
      linkStart: (address: string) => json<{ message: string }>("/api/openserv/link/start", { method: "POST", body: JSON.stringify({ address }) }),
      linkFinish: (address: string, message: string, signature: string) =>
        json<{ ok: boolean; openservUserId: string }>("/api/openserv/link/finish", { method: "POST", body: JSON.stringify({ address, message, signature }) }),

      getQuota: () => json<{ quota: QuotaDTO }>("/api/uses").then((d) => d.quota),

      getWallet: () => json<{ wallet: WalletDTO }>("/api/wallet").then((d) => d.wallet),
      checkDeposits: () => json<{ wallet: WalletDTO }>("/api/deposits/check", { method: "POST" }).then((d) => d.wallet),
      getAdmin: () => json<{ admin: AdminDTO }>("/api/admin").then((d) => d.admin),
      getAdminSafety: () => json<{ safety: AdminSafetyDTO }>("/api/admin/safety").then((d) => d.safety),
      // The audit log of guarded actions: the renter's installation, the
      // maker's agent (renters' data hidden), or all of it for an admin.
      installationAudit: (id: string, before?: string | null) =>
        json<{ audit: AuditPageDTO }>(`/api/installations/${encodeURIComponent(id)}/audit${before ? `?before=${encodeURIComponent(before)}` : ""}`).then((d) => d.audit),
      makerAudit: (id: string, before?: string | null) =>
        json<{ audit: AuditPageDTO }>(`/api/agents/${encodeURIComponent(id)}/audit${before ? `?before=${encodeURIComponent(before)}` : ""}`).then((d) => d.audit),
      adminAudit: (before?: string | null) => json<{ audit: AuditPageDTO }>(`/api/admin/audit${before ? `?before=${encodeURIComponent(before)}` : ""}`).then((d) => d.audit),
      adminModerate: (body: { type: "report" | "listing" | "request" | "offer" | "reppo" | "payment" | "dispute"; id: string; action: "approve" | "hide" | "freeze" | "uphold" | "reject"; reason: string }) =>
        json<{ safety: AdminSafetyDTO }>("/api/admin/moderate", { method: "POST", body: JSON.stringify(body) }).then((d) => d.safety),
      report: (body: { kind: "agent" | "maker" | "request" | "offer"; targetId: string; reason: string; note: string }) =>
        json<{ ok: boolean }>("/api/reports", { method: "POST", body: JSON.stringify(body) }).then(() => undefined),
      adminFreeze: (body: { kind: "agent" | "version" | "maker" | "renter"; target: string; reason: string }) =>
        json<{ safety: AdminSafetyDTO }>("/api/admin/freezes", { method: "POST", body: JSON.stringify(body) }).then((d) => d.safety),
      adminLift: (id: string, reason: string) =>
        json<{ safety: AdminSafetyDTO }>(`/api/admin/freezes/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ reason }) }).then((d) => d.safety),
      adminPause: (paused: boolean) => json<{ admin: AdminDTO }>("/api/admin/pause", { method: "POST", body: JSON.stringify({ paused }) }).then((d) => d.admin),
      // The site wide switch for agents' payments, with why when pausing.
      adminAgentPayments: (paused: boolean, reason?: string) => json<{ admin: AdminDTO }>("/api/admin/agent-payments", { method: "POST", body: JSON.stringify({ paused, reason }) }).then((d) => d.admin),
      adminDecide: (id: string, action: "approve" | "reject" | "fail") =>
        json<{ admin: AdminDTO }>(`/api/admin/withdrawals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action }) }).then((d) => d.admin),
      adminAccess: (id: string, action: "approve" | "reject") =>
        json<{ admin: AdminDTO }>(`/api/admin/access/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action }) }).then((d) => d.admin),
      requestWithdrawal: (body: { currency: "USDC" | "SERV"; amount: string; to: string; key: string }) =>
        json<{ wallet: WalletDTO }>("/api/withdrawals", { method: "POST", body: JSON.stringify(body) }).then((d) => d.wallet),

      // Use a published helper once, streamed, paying `pay` (the currency and
      // the price the page showed) when it has prices. Returns an abort
      // function.
      runHelper(slug: string, input: string, on: (e: HelperEvent) => void, pay?: { currency: "USDC" | "SERV"; price: string }): () => void {
        const controller = new AbortController();
        (async () => {
          try {
            const res = await authed(`/api/helpers/${encodeURIComponent(slug)}/use`, { method: "POST", body: JSON.stringify({ input, ...pay }), signal: controller.signal });
            if (!res.ok || !res.body) {
              const body = (await res.json().catch(() => ({}))) as { error?: string; quota?: QuotaDTO; balance?: BalanceDTO; prices?: PriceDTO[] };
              on({ type: "error", message: body.error ?? "The helper could not start. Try again.", quota: body.quota, balance: body.balance, prices: body.prices });
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
              const refused = (await res.json().catch(() => ({}))) as { error?: string; limit?: "site" | "chat" };
              on({ type: "error", message: refused.limit && refused.error ? refused.error : "The reply could not start. You can retry.", limit: refused.limit });
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
