// Puts the example agents on the board: restock, the morning sheet report
// and the enquiry follow-up, from their saved files in
// src/lib/agents/examples, each published and free to rent, owned by the
// first account named in ADMIN_USER_IDS. No model call. Running it again
// changes nothing for an example already there. The owner runs it once
// after deploying, against the database in DATABASE_URL:
//
//   npx vite-node --config vitest.config.ts scripts/import-examples.ts

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serverRuntime } from "@/lib/agents/runtime/context";
import { exampleOwner, importExample, type SavedExample } from "@/lib/market/examples";
import { paymentsConfig } from "@/lib/payments/config";

const FILES = ["restock", "sheet-report", "lead-followup"];

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
    const got = await importExample(rt, owner, JSON.parse(readFileSync(path, "utf8")) as SavedExample);
    console.log(`  ${got.name}: ${got.created ? "on the board now" : "already there"} (${got.agentId})`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "import failed");
    process.exit(1);
  });
