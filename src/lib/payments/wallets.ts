import "server-only";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "../db";
import { linkedWallets } from "../db/schema";
import type { Exec } from "./ledger";

// A user's linked wallets, as Privy reports them: the embedded wallet and any
// external wallet linked with a signature. Only Privy's word counts, never an
// address the browser sends.
export interface PrivyWallet {
  address: string;
  embedded: boolean;
}

// Bring the stored copy in step with Privy: add or move what Privy lists for
// this user, drop what it no longer lists.
export async function syncWallets(userId: string, wallets: PrivyWallet[]): Promise<void> {
  const list = wallets.filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w.address)).map((w) => ({ address: w.address.toLowerCase(), embedded: w.embedded }));
  await db.transaction(async (tx) => {
    for (const w of list) {
      await tx
        .insert(linkedWallets)
        .values({ address: w.address, userId, embedded: w.embedded })
        .onConflictDoUpdate({ target: linkedWallets.address, set: { userId, embedded: w.embedded } });
    }
    const keep = list.map((w) => w.address);
    await tx
      .delete(linkedWallets)
      .where(keep.length ? and(eq(linkedWallets.userId, userId), notInArray(linkedWallets.address, keep)) : eq(linkedWallets.userId, userId));
  });
}

export async function walletsOf(userId: string, exec: Exec = db): Promise<PrivyWallet[]> {
  const rows = await exec
    .select({ address: linkedWallets.address, embedded: linkedWallets.embedded })
    .from(linkedWallets)
    .where(eq(linkedWallets.userId, userId))
    .orderBy(linkedWallets.linkedAt);
  return rows;
}

// The user a wallet is linked to, if any.
export async function ownerOf(exec: Exec, address: string): Promise<string | null> {
  const [row] = await exec.select({ userId: linkedWallets.userId }).from(linkedWallets).where(eq(linkedWallets.address, address.toLowerCase())).limit(1);
  return row?.userId ?? null;
}
