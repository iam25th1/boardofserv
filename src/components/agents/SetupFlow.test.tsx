import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setupShapeOf, type AgentDefinition } from "@/lib/agents/definition";
import type { InstallAnswers } from "@/lib/agents/settingsForm";
import restock from "@/lib/agents/examples/restock.json";
import type { ConnectionDTO, InstallationDTO, JobDTO } from "@/lib/types";
import { SetupFlow, type SetupApi } from "./SetupFlow";

// Setting the example agent up: its questions, Telegram, Google and its
// sheets, its rules, then a test run before it goes live.

const definition = restock.definition as AgentDefinition;
const LINK = "https://docs.google.com/spreadsheets/d/FabricShopSheet0123456789abc/edit#gid=";

const conn = (provider: "telegram" | "google", label: string): ConnectionDTO => ({ provider, name: provider, label, connectedAt: "2026-11-09T08:00:00Z", lastUsedAt: null, usedBy: [] });

const installation = (o: Partial<InstallationDTO> = {}): InstallationDTO =>
  ({
    id: "inst-1",
    agentId: "a1",
    name: definition.name,
    version: 1,
    status: "testing",
    pausedReason: null,
    needs: { telegram: true, google: true },
    missing: [],
    timezone: "UTC",
    settings: [],
    rules: [],
    minGapMinutes: 5,
    dailySpendUsd: 0.5,
    createdAt: "2026-11-09T08:00:00Z",
    runs: [],
    nextRunAt: null,
    takesMessages: false,
    checkNote: null,
    memory: [],
    spendTodayUsd: 0,
    recentJobs: [],
    approvals: [],
    ...o,
  }) as InstallationDTO;

const testJob = { id: "job-1", installationId: "inst-1", agentName: definition.name, status: "done" as const, reason: "It reached the end of its steps.", started: "as a test run", trigger: "test", createdAt: "2026-11-09T08:01:00Z", finishedAt: "2026-11-09T08:01:05Z", costUsd: 0.001, ms: 5000, stepCount: 6, mine: true };
const job: JobDTO = { ...testJob, viewer: "owner", version: 1, untrusted: [], steps: [], plan: [], approvals: [] };

function makeApi() {
  let telegram = false;
  const api = {
    connections: vi.fn(async () => ({ connections: [...(telegram ? [conn("telegram", "@shop")] : []), conn("google", "shop@example.com")], available: { telegram: true, google: true } })),
    telegramCode: vi.fn(async () => {
      telegram = true;
      return { code: "ABCDEF2345", link: "https://t.me/boardofservbot?start=ABCDEF2345", bot: "boardofservbot", expiresAt: new Date(Date.now() + 600_000).toISOString() };
    }),
    googleStart: vi.fn(async () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth?x" })),
    inspectSheet: vi.fn(async () => ({ title: "Fabric shop", tabs: [{ id: 0, title: "Stock" }, { id: 7, title: "Orders" }] })),
    install: vi.fn(async (_answers: InstallAnswers) => installation()),
    control: vi.fn(async (_id: string, action: string) => (action === "golive" ? installation({ status: "active" }) : installation({ recentJobs: [testJob] }))),
    installation: vi.fn(async () => installation()),
    job: vi.fn(async () => job),
    answer: vi.fn(async () => {}),
  } satisfies SetupApi;
  return api;
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
const here = () => screen.getByRole("listitem", { current: "step" }).textContent;

describe("setting an agent up", () => {
  it("goes through its questions, Telegram, its sheets and its rules, then a test run, then live", async () => {
    const api = makeApi();
    const done = vi.fn();
    render(<SetupFlow agentId="a1" setup={setupShapeOf(definition)} defaults={restock.bench.settings} api={api} returnTo="/app/agents/a1?setup=1" onDone={done} />);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1Its questions", "2Link Telegram", "3Your sheets", "4Rules and limits", "5Test run"]);

    // 1. Its questions, checked before going on.
    fireEvent.change(screen.getByLabelText(/Address of the suppliers' price list page/), { target: { value: "not a link" } });
    next();
    expect(await screen.findByText("Some answers need another look.")).toBeInTheDocument();
    expect(here()).toBe("1Its questions");
    fireEvent.change(screen.getByLabelText(/Address of the suppliers' price list page/), { target: { value: "https://suppliers.example/prices" } });
    next();
    await waitFor(() => expect(here()).toBe("2Link Telegram"));

    // 2. Telegram: not on until it is linked.
    next();
    expect(await screen.findByText("Link Telegram first: this agent messages you there.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link Telegram" }));
    expect(await screen.findByText("/start ABCDEF2345")).toBeInTheDocument();
    next();
    await waitFor(() => expect(here()).toBe("3Your sheets"));

    // 3. Google is connected: each sheet's link opened and a tab picked.
    expect(screen.getByText(/Google is connected as shop@example.com/)).toBeInTheDocument();
    for (const [key, gid, tab] of [["stock_sheet", 0, "Stock"], ["orders_sheet", 7, "Orders"]] as const) {
      fireEvent.change(document.getElementById(`setup-${key}`)!, { target: { value: `${LINK}${gid}` } });
      fireEvent.click(screen.getAllByRole("button", { name: "Open it" })[key === "stock_sheet" ? 0 : 1]!);
      expect(await screen.findByDisplayValue(tab)).toBeInTheDocument();
    }
    next();
    await waitFor(() => expect(here()).toBe("4Rules and limits"));

    // 4. Rules, with the maker's defaults.
    expect(screen.getByLabelText(/Order approval limit/)).toHaveValue("250");
    fireEvent.change(screen.getByLabelText(/Order approval limit/), { target: { value: "50" } });
    next();
    await waitFor(() => expect(here()).toBe("5Test run"));

    // 5. Set up for a test (not live), run once, then live.
    fireEvent.click(screen.getByRole("button", { name: "Set it up for a test" }));
    await waitFor(() => expect(api.install).toHaveBeenCalledTimes(1));
    expect(api.install.mock.calls[0]![0]).toMatchObject({
      settings: { suppliers_page: "https://suppliers.example/prices", stock_sheet: { url: `${LINK}0`, tab: "Stock" }, orders_sheet: { url: `${LINK}7`, tab: "Orders" } },
      rules: { approval_limit: "50" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Run the test" }));
    expect(await screen.findByText("The test went through. Make it live to run on its own from now on.")).toBeInTheDocument();
    expect(api.control).toHaveBeenCalledWith("inst-1", "test");
    fireEvent.click(screen.getByRole("button", { name: "Make it live" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith("inst-1"));
    expect(api.control).toHaveBeenLastCalledWith("inst-1", "golive");
    // Nothing kept once it is live.
    expect(window.sessionStorage.getItem("bos-setup:a1")).toBeNull();
  });

  it("picks up where it was after the way to Google and back", async () => {
    const api = makeApi();
    const first = render(<SetupFlow agentId="a1" setup={setupShapeOf(definition)} defaults={restock.bench.settings} api={api} returnTo="/app/agents/a1?setup=1" onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Address of the suppliers' price list page/), { target: { value: "https://suppliers.example/prices" } });
    next();
    await waitFor(() => expect(here()).toBe("2Link Telegram"));
    first.unmount();
    render(<SetupFlow agentId="a1" setup={setupShapeOf(definition)} defaults={restock.bench.settings} api={api} returnTo="/app/agents/a1?setup=1" onDone={() => {}} />);
    await waitFor(() => expect(here()).toBe("2Link Telegram"));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText(/Address of the suppliers' price list page/)).toHaveValue("https://suppliers.example/prices");
  });
});
