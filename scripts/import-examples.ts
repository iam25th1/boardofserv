// Puts the example agents on the board: restock, the morning sheet report
// and the enquiry follow-up, from their saved files in
// src/lib/agents/examples, each published and free to rent, owned by the
// first account named in ADMIN_USER_IDS. No model call. Running it again
// changes nothing for an example already there. The owner runs it once
// after deploying, against the database in DATABASE_URL:
//
//   npx vite-node --config vitest.config.ts scripts/import-examples.ts
//
// With --update, an example already on the board whose saved plan or code
// changed gets a new version the normal way: SERV's code review, published,
// the board moved to it, its renters offered it, its listing screened
// again (so this one makes model calls, on SERV_API_KEY). One that is up to
// date is left alone; one that isn't there is put on the board.
//
//   npx vite-node --config vitest.config.ts scripts/import-examples.ts -- --update

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { exampleOwner, importExample, updateExample, type SavedExample } from "@/lib/market/examples";
import { vetVersion } from "@/lib/agents/publish";
import { offerVersion } from "@/lib/market/versions";
import { screenListing } from "@/lib/safety/moderation";
import { paymentsConfig } from "@/lib/payments/config";

const FILES = ["restock", "sheet-report", "lead-followup"];

const update = process.argv.includes("--update");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("import: set DATABASE_URL to the database to put the examples in");
  const rt = serverRuntime();
  const owner = await exampleOwner(rt, paymentsConfig().adminUserIds);
  if (!owner) throw new Error("import: no account matches ADMIN_USER_IDS; sign in once as the admin, then run this again");
  for (const name of FILES) {
    const path = fileURLToPath(new URL(`../src/lib/agents/examples/${name}.json`, import.meta.url));
    if (!existsSync(path)) {
      console.log(`  ${name}: no saved file, skipped`);
      continue;
    }
    const saved = JSON.parse(readFileSync(path, "utf8")) as SavedExample;
    if (update) {
      const got = await updateExample(rt, owner, saved, { vet: vetVersion, offer: offerVersion, screen: screenListing });
      const said = got.outcome === "updated" ? `updated to version ${got.version}, offered to ${got.offered} ${got.offered === 1 ? "renter" : "renters"}` : got.outcome === "refused" ? `not updated: ${got.why}` : got.outcome === "created" ? "on the board now" : "up to date";
      console.log(`  ${got.name}: ${said} (${got.agentId})`);
      continue;
    }
    const got = await importExample(rt, owner, saved);
    console.log(`  ${got.name}: ${got.created ? "on the board now" : "already there"} (${got.agentId})`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "import failed");
    process.exit(1);
  });
