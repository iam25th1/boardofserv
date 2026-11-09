// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { addUser, testDb } from "@/test/helperDb";
import { installed, publishedAgent, testRuntime, type TestRuntime } from "@/test/runtimeFixtures";
import { control, ControlRefused, installationDTO, loadInstallation } from "../agents/runtime/installations";
import { chatLookup, connectionsOf, disconnect, keep, ownerOfChat, secretOf } from "./vault";

// The connection vault: secrets encrypted at rest, decrypted only for the
// server's own calls, never in what the owner is shown; disconnecting
// revokes and pauses what needs it.

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let rt: TestRuntime;
let owner: schema.User;
let other: schema.User;

beforeAll(async () => {
  ({ client, db } = await testDb());
  rt = testRuntime(db);
  owner = await addUser(db, "vault.owner");
  other = await addUser(db, "vault.other");
});
afterAll(async () => {
  await client.close();
});

describe("the vault", () => {
  it("keeps secrets encrypted, and hands them back only to the server", async () => {
    await keep(rt, owner.id, "telegram", "@owner", { chatId: 5550001, userId: 5550001 });
    await keep(rt, owner.id, "google", "owner@example.com", { refreshToken: "refresh-secret-xyz", accessToken: "access-secret-xyz", expiresAt: 1, scope: "s" });
    const rows = await db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, owner.id));
    expect(rows).toHaveLength(2);
    const raw = JSON.stringify(rows);
    for (const secret of ["5550001", "refresh-secret-xyz", "access-secret-xyz"]) expect(raw).not.toContain(secret);
    // The chat is found by its keyed hash, not by its id.
    expect(rows.find((r) => r.provider === "telegram")!.lookup).toBe(chatLookup(5550001));
    expect(await ownerOfChat(rt, 5550001)).toBe(owner.id);
    expect(await ownerOfChat(rt, 5550002)).toBeNull();
    expect((await secretOf(rt, owner.id, "google"))!.refreshToken).toBe("refresh-secret-xyz");
    expect(await secretOf(rt, other.id, "google")).toBeNull();
  });

  it("shows the owner labels and dates, never a secret", async () => {
    const list = await connectionsOf(rt, owner.id);
    expect(list.map((c) => [c.provider, c.label])).toEqual(
      expect.arrayContaining([
        ["telegram", "@owner"],
        ["google", "owner@example.com"],
      ]),
    );
    const shown = JSON.stringify(list);
    for (const secret of ["5550001", "refresh-secret-xyz", "access-secret-xyz", "secretEncrypted", "lookup"]) expect(shown).not.toContain(secret);
    expect(await connectionsOf(rt, other.id)).toEqual([]);
  });

  it("links a chat to one owner at a time", async () => {
    await expect(keep(rt, other.id, "telegram", "@other", { chatId: 5550001, userId: 5550001 })).rejects.toThrow();
  });

  it("disconnecting revokes at Google, forgets the secret and pauses what needs it, saying why", async () => {
    const p = await publishedAgent(db, owner);
    const inst = await installed(rt, owner, p);
    const revoked: string[] = [];
    rt.net.on("https://oauth2.googleapis.com/revoke", (req) => {
      revoked.push(String(req.json().token));
      return new Response("{}", { status: 200 });
    });
    const r = await disconnect(rt, owner.id, "google");
    expect(r).toEqual({ revoked: true, paused: 1 });
    expect(revoked).toEqual(["refresh-secret-xyz"]);
    expect(await secretOf(rt, owner.id, "google")).toBeNull();
    const l = (await loadInstallation(rt, inst.id))!;
    expect(l.installation.status).toBe("paused");
    const dto = await installationDTO(rt, l);
    expect(dto.pausedReason).toMatch(/Google was disconnected/);
    expect(dto.missing).toEqual(["google"]);
    // It can't run again until Google is back.
    await expect(control(rt, l, "resume")).rejects.toThrow(ControlRefused);
    await keep(rt, owner.id, "google", "owner@example.com", { refreshToken: "r2", accessToken: null, expiresAt: null, scope: "s" });
    await control(rt, l, "resume");
    const back = (await loadInstallation(rt, inst.id))!;
    expect(back.installation.status).toBe("active");
    expect(back.installation.pausedReason).toBeNull();
    expect(await disconnect(rt, other.id, "google")).toBeNull();
  });

  it("says when Google couldn't be reached to revoke", async () => {
    rt.net.on("https://oauth2.googleapis.com/revoke", () => new Response("{}", { status: 500 }));
    expect((await disconnect(rt, owner.id, "google"))!.revoked).toBe(false);
    // Telegram has nothing to revoke.
    expect((await disconnect(rt, owner.id, "telegram"))!.revoked).toBeNull();
    expect(await ownerOfChat(rt, 5550001)).toBeNull();
  });
});
