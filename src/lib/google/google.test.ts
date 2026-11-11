// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { fakeSheetUrl } from "@/test/fakeNet";
import { installed, ownSheet, publishedAgent, sheetRows, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { claimJob, enqueue, runJob } from "../agents/runtime/jobs";
import { grantSheets, InstallRefused, loadInstallation } from "../agents/runtime/installations";
import { JobTools } from "../agents/runtime/tools";
import { keep, secretOf } from "../connections/vault";
import { accessToken, CallbackRefused, finishGoogle, REVOKED_REASON, startGoogle } from "./oauth";
import { parseSheetLink } from "./sheetLink";

// Google: connecting once (the web server flow, mocked at Google's
// endpoints), sheets reached only as the owner gave them, tokens refreshed
// when they run out, and a revoked one pausing what needs it.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  owner = await addUser(db, "g.owner");
});
afterAll(async () => client.close());
beforeEach(async () => {
  await db.update(schema.agentJobs).set({ status: "cancelled" }).where(inArray(schema.agentJobs.status, ["queued", "running", "waiting_for_owner"]));
  await db.update(schema.agentInstallations).set({ status: "stopped" });
  rt = testRuntime(db);
  rt.serve = (ids) => (ids.includes("within") ? "within" : ids[0]!);
});

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;

describe("connecting Google", () => {
  it("asks for sheets and lasting access, with a state tied to this browser", async () => {
    const { url, state } = await startGoogle(rt, owner.id, "/app/installations/abc");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: "test-client",
      redirect_uri: "https://boardofserv.test/api/connections/google/callback",
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/spreadsheets",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    // Only its hash is kept.
    const rows = await db.select().from(schema.googleOAuthStates);
    expect(JSON.stringify(rows)).not.toContain(state);
  });

  it("keeps the tokens when the code comes back to the browser that started, once", async () => {
    const { state } = await startGoogle(rt, owner.id, "/app/connections");
    const sent: Record<string, unknown>[] = [];
    rt.net.on("https://oauth2.googleapis.com/token", (req) => {
      sent.push(req.json());
      return Response.json({ access_token: "acc-1", refresh_token: "ref-1", expires_in: 3599, scope: "openid https://www.googleapis.com/auth/spreadsheets email", id_token: idToken("shop@example.com") });
    });
    const done = await finishGoogle(rt, { state, cookie: state, code: "the-code", error: null });
    expect(done).toEqual({ ownerUserId: owner.id, returnTo: "/app/connections" });
    expect(sent[0]).toMatchObject({ code: "the-code", grant_type: "authorization_code", client_secret: "test-google-secret", redirect_uri: "https://boardofserv.test/api/connections/google/callback" });
    expect(await secretOf(rt, owner.id, "google")).toMatchObject({ refreshToken: "ref-1", accessToken: "acc-1" });
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, owner.id));
    expect(c!.label).toBe("shop@example.com");
    // Used up.
    await expect(finishGoogle(rt, { state, cookie: state, code: "the-code", error: null })).rejects.toThrow(CallbackRefused);
  });

  it("refuses a state from another browser, one too old, a refusal at Google, and access without sheets", async () => {
    const a = await startGoogle(rt, owner.id, "/app/connections");
    await expect(finishGoogle(rt, { state: a.state, cookie: "someone-else", code: "c", error: null })).rejects.toThrow(/didn't start in this browser/);
    await expect(finishGoogle(rt, { state: a.state, cookie: null, code: "c", error: null })).rejects.toThrow(/didn't start in this browser/);
    const b = await startGoogle(rt, owner.id, "/app/connections");
    rt.clock.move(10 * 60_000 + 1);
    await expect(finishGoogle(rt, { state: b.state, cookie: b.state, code: "c", error: null })).rejects.toThrow(/took too long/);
    const c = await startGoogle(rt, owner.id, "/app/connections");
    await expect(finishGoogle(rt, { state: c.state, cookie: c.state, code: null, error: "access_denied" })).rejects.toThrow("You said no at Google, so nothing was connected.");
    const d = await startGoogle(rt, owner.id, "/app/connections");
    rt.net.on("https://oauth2.googleapis.com/token", () => Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid email" }));
    await expect(finishGoogle(rt, { state: d.state, cookie: d.state, code: "c", error: null })).rejects.toThrow(/tick the box for Google Sheets/);
  });

  it("goes back only to a page of this site", async () => {
    const { state } = await startGoogle(rt, owner.id, "https://elsewhere.example/steal");
    const [row] = await db.select().from(schema.googleOAuthStates).orderBy(schema.googleOAuthStates.createdAt);
    expect(row).toBeTruthy();
    rt.net.on("https://oauth2.googleapis.com/token", () => Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "https://www.googleapis.com/auth/spreadsheets" }));
    expect((await finishGoogle(rt, { state, cookie: state, code: "c", error: null })).returnTo).toBe("/app/connections");
  });
});

describe("tokens", () => {
  it("refreshes an access token that has run out, and keeps the new one", async () => {
    await keep(rt, owner.id, "google", "o@example.com", { refreshToken: "ref-x", accessToken: "old", expiresAt: rt.now().getTime() + 30_000, scope: "s" });
    const sent: Record<string, unknown>[] = [];
    rt.net.on("https://oauth2.googleapis.com/token", (req) => {
      sent.push(req.json());
      return Response.json({ access_token: "new-access", expires_in: 3600 });
    });
    expect(await accessToken(rt, owner.id)).toBe("new-access");
    expect(sent[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "ref-x" });
    expect(await secretOf(rt, owner.id, "google")).toMatchObject({ refreshToken: "ref-x", accessToken: "new-access" });
    // Still good: no second refresh.
    expect(await accessToken(rt, owner.id)).toBe("new-access");
    expect(sent).toHaveLength(1);
  });

  it("a revoked token stops the job, forgets the connection and pauses the installation, saying why", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    await keep(rt, owner.id, "google", "o@example.com", { refreshToken: "revoked", accessToken: null, expiresAt: null, scope: "s" });
    rt.net.on("https://oauth2.googleapis.com/token", () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }));
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    const [j] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
    expect(j).toMatchObject({ status: "cancelled", reason: REVOKED_REASON });
    const l = (await loadInstallation(rt, inst.id))!;
    expect(l.installation).toMatchObject({ status: "paused", pausedReason: REVOKED_REASON });
    expect(await secretOf(rt, owner.id, "google")).toBeNull();
    await expect(accessToken(rt, owner.id)).resolves.toBeNull();
  });

  it("refreshes once and tries again when Google says the token ran out early", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    let refused = 0;
    rt.net.on(/sheets\.googleapis\.com/, (req) => {
      if (req.headers.get("authorization") === `Bearer access-${owner.id}` && refused++ === 0) return new Response("{}", { status: 401 });
      return Response.json({ values: [["fabric", "metres", "minimum"], ["Silk", 1, 5]] });
    });
    const tools = new JobTools(rt, inst, (await loadInstallation(rt, inst.id))!.definition, null);
    const step = (await loadInstallation(rt, inst.id))!.definition.steps[0]!;
    expect(await tools.call(step, "sheets.read", { sheet: "Stock" })).toEqual({ rows: [{ fabric: "Silk", metres: 1, minimum: 5, _row: 2 }] });
  });
});

describe("sheets, as the owner gave them", () => {
  it("installing opens each link on the owner's access and keeps the tab picked", async () => {
    await keep(rt, owner.id, "google", "o@example.com", { refreshToken: "r", accessToken: "a", expiresAt: rt.now().getTime() + 3_600_000, scope: "s" });
    const sheet = ownSheet(rt);
    const d = (await publishedAgent(db, owner)).version.definition!;
    const { settings, sheets } = await grantSheets(rt, owner.id, d, { stock_sheet: sheet.answer("Stock"), orders_sheet: sheet.answer("Orders"), suppliers_sheet: sheet.answer("Suppliers") });
    expect(settings).toEqual({ stock_sheet: "Stock", orders_sheet: "Orders", suppliers_sheet: "Suppliers" });
    expect(sheets.orders_sheet).toMatchObject({ spreadsheetId: sheet.id, tab: "Orders", title: expect.stringMatching(/^Fabric shop/) });
    // A tab the sheet doesn't have, a sheet that isn't there, and no link.
    await expect(grantSheets(rt, owner.id, d, { stock_sheet: sheet.answer("Stockk"), orders_sheet: sheet.answer("Orders"), suppliers_sheet: { url: fakeSheetUrl("MissingSheet0123456789abcdef"), tab: "x" } })).rejects.toMatchObject({
      errors: { stock_sheet: expect.stringMatching(/has no tab called "Stockk"/), suppliers_sheet: "That sheet isn't there any more (or the link is wrong)." },
    });
    await expect(grantSheets(rt, owner.id, d, { stock_sheet: "Stock", orders_sheet: sheet.answer("Orders"), suppliers_sheet: sheet.answer("Suppliers") })).rejects.toMatchObject({ errors: { stock_sheet: "Paste the link of a Google Sheet, then pick its tab." } });
  });

  it("needs Google connected first", async () => {
    const u = await addUser(db, "g.nogoogle");
    const d = (await publishedAgent(db, u)).version.definition!;
    await expect(grantSheets(rt, u.id, d, {})).rejects.toThrow(InstallRefused);
  });

  it("reaches only the tabs given, whatever the code asks for", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    // Another of the owner's sheets, never given to this installation.
    const other = ownSheet(rt, { Payroll: [{ name: "x", pay: 1 }] });
    const d = (await loadInstallation(rt, inst.id))!.definition;
    const tools = new JobTools(rt, inst, d, null);
    const step = d.steps[0]!;
    await expect(tools.call(step, "sheets.read", { sheet: "Payroll" })).rejects.toThrow('This agent wasn\'t given a sheet called "Payroll". It was given "Stock", "Orders", "Suppliers".');
    await expect(tools.call(step, "sheets.read", { sheet: other.id })).rejects.toThrow(/wasn't given a sheet called/);
    expect((await tools.call(step, "sheets.read", { sheet: "Stock" })) as { rows: unknown[] }).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ fabric: "Wool felt" })]) });
    // By the setting's own name too.
    expect(((await tools.call(step, "sheets.read", { sheet: "stock_sheet" })) as { rows: unknown[] }).rows).toHaveLength(3);
    expect(rt.net.calls.filter((c) => c.url.pathname.includes(other.id))).toHaveLength(0);
  });

  it("writes rows as values, never formulas, adding columns it needs, and can replace a tab", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const d = (await loadInstallation(rt, inst.id))!.definition;
    const tools = new JobTools(rt, inst, d, null);
    const step = d.steps[0]!;
    await tools.call(step, "sheets.write", { sheet: "Orders", rows: [{ fabric: "Silk", metres: 3 }, { fabric: "=IMPORTXML(\"x\")", metres: 1, note: "rush" }] });
    expect(sheetRows(rt, inst, "orders_sheet")).toEqual([
      { fabric: "Silk", metres: 3, note: null },
      { fabric: '=IMPORTXML("x")', metres: 1, note: "rush" },
    ]);
    expect(rt.net.calls.filter((c) => c.method === "POST" || c.method === "PUT").every((c) => c.url.search.includes("valueInputOption=RAW") || c.url.pathname.endsWith(":clear"))).toBe(true);
    await tools.call(step, "sheets.write", { sheet: "Orders", rows: [{ fabric: "Wool", metres: 9 }], mode: "replace" });
    expect(sheetRows(rt, inst, "orders_sheet")).toEqual([{ fabric: "Wool", metres: 9 }]);
  });

  it("keeps to the installation's sheet calls a day", async () => {
    rt.services.caps.sheetCalls = 2;
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    const d = (await loadInstallation(rt, inst.id))!.definition;
    const tools = new JobTools(rt, inst, d, null);
    await tools.call(d.steps[0]!, "sheets.read", { sheet: "Stock" });
    await tools.call(d.steps[0]!, "sheets.read", { sheet: "Stock" });
    await expect(tools.call(d.steps[0]!, "sheets.read", { sheet: "Stock" })).rejects.toThrow("It reached its limit of 2 sheet calls today.");
    rt.clock.move(86_400_000);
    await expect(tools.call(d.steps[0]!, "sheets.read", { sheet: "Stock" })).resolves.toBeTruthy();
  });

  it("tries again later when Google is over its rate limit", async () => {
    const inst = await installed(rt, owner, await publishedAgent(db, owner));
    rt.net.on(/sheets\.googleapis\.com/, () => new Response("{}", { status: 429 }));
    const job = await enqueue(rt, inst, { kind: "manual" });
    await runJob(rt, (await claimJob(rt, "w"))!, "w");
    const [j] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, job.id));
    expect(j).toMatchObject({ status: "queued", attempts: 1 });
  });
});

describe("sheet links", () => {
  it("reads the spreadsheet and the tab from a link, and nothing else", () => {
    expect(parseSheetLink("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=123")).toEqual({ spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345", gid: 123 });
    expect(parseSheetLink("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345")).toEqual({ spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345", gid: null });
    expect(parseSheetLink("http://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345")).toBeNull();
    expect(parseSheetLink("https://docs.google.com.evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345")).toBeNull();
    expect(parseSheetLink("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345")).toBeNull();
    expect(parseSheetLink("not a link")).toBeNull();
  });
});
