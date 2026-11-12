// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { resetPaymentsConfig } from "@/lib/payments/config";
import { confirmSuggestion, markPaid, MAX_PAYEES, payeesOf, PayeeRefused, readAddress, readLabel, removePayee, resolvePayee, savePayee, suggestPayee } from "./payees";

// Saved payees: a name and a Base address each, checked and checksummed;
// a new address for a name is a new payee; an agent's suggestion waits for
// the renter to confirm it on screen; an agent pays nobody else.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let renter: schema.User;
let other: schema.User;

const SUPPLIER = "0xF3fA00a093b023929b8C0C3Af790E0dCaAcFE84b";
const TREASURY = "0x7Ea5C0fFee2B6f4E3c9A1d0B8e7F6a5C4d3B2a19";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

beforeAll(async () => {
  ({ client, db } = await testDb());
  renter = await addUser(db, "payees.renter");
  other = await addUser(db, "payees.other");
});
afterAll(async () => client.close());
beforeEach(() => {
  rt = testRuntime(db);
  vi.stubEnv("TREASURY_ADDRESS", TREASURY);
  resetPaymentsConfig();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetPaymentsConfig();
});

const inst = async () => installed(rt, renter, await publishedAgent(db, renter));
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as PayeeRefused);

describe("payee addresses and names", () => {
  it("take a Base address, checksummed, and refuse typos, zero, the treasury and the USDC contract", () => {
    expect(readAddress(SUPPLIER.toLowerCase())).toBe(SUPPLIER);
    expect(readAddress(` ${SUPPLIER} `)).toBe(SUPPLIER);
    const typo = SUPPLIER.replace("fA0", "fa0");
    for (const bad of [typo, "0x0000000000000000000000000000000000000000", TREASURY, TREASURY.toLowerCase(), "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "0x123", "supplier.eth", "", null, 42]) {
      expect(readAddress(bad), String(bad)).toBeNull();
    }
  });

  it("take a short plain name", () => {
    expect(readLabel("  Weftworks   Ltd ")).toBe("Weftworks Ltd");
    expect(readLabel("Mill\nNorth")).toBe("Mill North");
    for (const bad of ["", "  ", "x".repeat(41), "<script>", "@everyone", "{{x}}", 7]) expect(readLabel(bad), String(bad)).toBeNull();
  });
});

describe("saved payees", () => {
  it("are saved by name, and a new address for a name is a new payee", async () => {
    const i = await inst();
    const first = await savePayee(rt, renter, i.id, { label: "Weftworks", address: SUPPLIER.toLowerCase() });
    expect(first).toMatchObject({ label: "Weftworks", address: SUPPLIER, status: "active", firstPaidAt: null });
    expect((await savePayee(rt, renter, i.id, { label: "weftworks", address: SUPPLIER })).id).toBe(first.id);
    await markPaid(db as never, first.id, rt.now());
    const moved = await savePayee(rt, renter, i.id, { label: "Weftworks", address: addr(7) });
    expect(moved.id).not.toBe(first.id);
    expect(moved.firstPaidAt).toBeNull();
    expect((await db.select().from(schema.payees).where(eq(schema.payees.id, first.id)))[0]!.status).toBe("removed");
    expect((await payeesOf(rt, i.id)).map((p) => p.label)).toEqual(["Weftworks"]);
  });

  it("rename a saved address in place, refuse it under a second name, past the maximum, and anyone else's installation", async () => {
    const i = await inst();
    const mill = await savePayee(rt, renter, i.id, { label: "Mill", address: SUPPLIER });
    // A new name for the same address renames it: the same payee, its history kept.
    const renamed = await savePayee(rt, renter, i.id, { label: "Other mill", address: SUPPLIER });
    expect(renamed).toMatchObject({ id: mill.id, label: "Other mill", address: SUPPLIER });
    await savePayee(rt, renter, i.id, { label: "Spare", address: addr(98) });
    // A name already used for another address, given to this one, is refused.
    expect((await refusal(savePayee(rt, renter, i.id, { label: "Spare", address: SUPPLIER })))?.status).toBe(409);
    await removePayee(rt, renter, i.id, (await payeesOf(rt, i.id)).find((p) => p.label === "Spare")!.id);
    for (let n = 1; n < MAX_PAYEES; n++) await savePayee(rt, renter, i.id, { label: `Payee ${n}`, address: addr(100 + n) });
    expect((await refusal(savePayee(rt, renter, i.id, { label: "One more", address: addr(999) })))?.message).toMatch(/at most 20/);
    expect((await refusal(savePayee(rt, other, i.id, { label: "Mine", address: addr(5) })))?.status).toBe(404);
    expect((await refusal(removePayee(rt, other, i.id, (await payeesOf(rt, i.id))[0]!.id)))?.status).toBe(404);
    expect((await refusal(savePayee(rt, renter, i.id, { label: "Bad", address: "0x12" })))?.status).toBe(400);
  });

  it("are what an agent can pay, by name or address; a removed one or a suggestion isn't", async () => {
    const i = await inst();
    const p = await savePayee(rt, renter, i.id, { label: "Weftworks", address: SUPPLIER });
    expect((await resolvePayee(rt, i.id, "WEFTWORKS"))?.id).toBe(p.id);
    expect((await resolvePayee(rt, i.id, SUPPLIER.toLowerCase()))?.id).toBe(p.id);
    expect(await resolvePayee(rt, i.id, "Someone else")).toBeNull();
    const theirs = await installed(rt, other, await publishedAgent(db, other));
    expect(await resolvePayee(rt, theirs.id, "Weftworks")).toBeNull();
    await removePayee(rt, renter, i.id, p.id);
    expect(await resolvePayee(rt, i.id, "Weftworks")).toBeNull();
    const s = await suggestPayee(rt, i.id, renter.id, addr(77), "Fabric restock");
    expect(s).toMatchObject({ status: "suggested", suggestedBy: "agent" });
    expect(await resolvePayee(rt, i.id, addr(77))).toBeNull();
  });

  it("an agent suggests wait for the renter to confirm them on screen, with a name, and say so", async () => {
    const i = await inst();
    const s = (await suggestPayee(rt, i.id, renter.id, addr(78), "Fabric restock"))!;
    expect(await suggestPayee(rt, i.id, renter.id, addr(78), "Fabric restock")).toMatchObject({ id: s.id });
    expect(await suggestPayee(rt, i.id, renter.id, "not an address", "Fabric restock")).toBeNull();
    const [said] = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.installationId, i.id));
    expect(said!.text).toMatch(/isn't one of your saved payees, so nothing was paid\. .+ it can't be added from here\.$/);
    expect((await refusal(confirmSuggestion(rt, other, i.id, s.id, "Mine")))?.status).toBe(404);
    expect((await refusal(confirmSuggestion(rt, renter, i.id, s.id, "")))?.status).toBe(400);
    const ok = await confirmSuggestion(rt, renter, i.id, s.id, "New supplier");
    expect(ok).toMatchObject({ status: "active", label: "New supplier", firstPaidAt: null });
    expect((await resolvePayee(rt, i.id, "New supplier"))?.id).toBe(s.id);
    expect((await refusal(confirmSuggestion(rt, renter, i.id, s.id, "Again")))?.status).toBe(404);
  });
});
