import "server-only";
import { desc, sql } from "drizzle-orm";
import { agentVersions } from "../../db/schema";
import type { Runtime } from "../runtime/context";
import { selfTest } from "../test";
import { reviewVersion } from "../vetting";
import { recipeUpgrade } from "./index";

// Agents built from a tested recipe that has a newer revision get it as a
// new published version, tested on the recipe's sample with no model
// asked, the way a build from it would be: their owners see "Version N is
// ready" with Switch on each copy that runs (installations.ts newerVersion),
// which keeps its settings and memory. An agent whose newest version is a
// draft (its owner is changing it) is left alone until it is published.
// Once a process, from the job worker; another process doing the same at
// once is turned away by the versions' numbers.
export async function upgradeRecipeAgents(rt: Runtime): Promise<number> {
  const rows = await rt.db
    .select()
    .from(agentVersions)
    .where(sql`${agentVersions.agentId} in (select agent_id from agent_versions where definition->'recipe' is not null)`)
    .orderBy(desc(agentVersions.number));
  const newest = new Map<string, (typeof rows)[number]>();
  for (const v of rows) if (!newest.has(v.agentId)) newest.set(v.agentId, v);
  let made = 0;
  for (const v of newest.values()) {
    if (v.state !== "published" || !v.definition) continue;
    const up = recipeUpgrade(v.definition, v.code);
    if (!up) continue;
    try {
      const tested = await selfTest({ definition: up.definition, code: up.code }, { serv: null, sample: up.recipe.sample(up.definition) });
      if (tested.result.status !== "passed") {
        rt.log(`recipes: agent ${v.agentId} wasn't moved to the ${up.recipe.id} recipe's revision ${up.recipe.rev}: its test didn't pass.`);
        continue;
      }
      const now = rt.now();
      const review = await reviewVersion(up.definition, up.code, null, { now });
      if (review.status !== "passed") continue;
      await rt.db.insert(agentVersions).values({
        agentId: v.agentId,
        number: v.number + 1,
        state: "published",
        publishedAt: now,
        definition: up.definition,
        code: up.code,
        bench: tested.bench,
        testResult: tested.result,
        review,
        createdAt: now,
        updatedAt: now,
      });
      made += 1;
      rt.log(`recipes: agent ${v.agentId} has version ${v.number + 1}, the ${up.recipe.id} recipe's revision ${up.recipe.rev}.`);
    } catch (err) {
      // Made by another process just now, or not made: either way, nothing
      // half done.
      rt.log(`recipes: agent ${v.agentId} wasn't moved to a newer recipe: ${err instanceof Error ? err.name : "unknown error"}`);
    }
  }
  return made;
}
