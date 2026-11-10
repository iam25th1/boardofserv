// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as stub from "@/lib/emptyModule";

// @ts-expect-error next.config.mjs is plain JavaScript, without types
const { default: nextConfig, PRIVY_SOLANA_ONLY } = (await import("../../next.config.mjs")) as { default: { turbopack?: { resolveAlias?: Record<string, string> } }; PRIVY_SOLANA_ONLY: string[] };

// Privy 3 imports two packages only for Solana, which the app doesn't have
// (src/lib/emptyModule.ts stands in for both). Turbopack checks that every
// name imported from a module exists, so the stub has to export each one
// Privy imports from them, or the build fails.

const DIST = join(process.cwd(), "node_modules/@privy-io/react-auth/dist/esm");

describe("Privy's Solana-only imports", () => {
  it("resolve to the stub in the build, and are not installed", () => {
    const alias = nextConfig.turbopack?.resolveAlias ?? {};
    for (const m of PRIVY_SOLANA_ONLY) {
      expect(alias[m], m).toBe("./src/lib/emptyModule.ts");
      expect(() => readFileSync(join(process.cwd(), "node_modules", m, "package.json")), m).toThrow();
    }
  });

  it("name nothing the stub doesn't export", () => {
    const named = new Set<string>();
    for (const f of readdirSync(DIST).filter((f) => f.endsWith(".mjs"))) {
      const src = readFileSync(join(DIST, f), "utf8");
      for (const m of PRIVY_SOLANA_ONLY) {
        const re = new RegExp(`import\\{([^}]*)\\}from"${m.replace(/[/@-]/g, (c: string) => `\\${c}`)}"`, "g");
        for (const hit of src.matchAll(re)) for (const part of hit[1]!.split(",")) named.add(part.trim().split(/\s+as\s+/)[0]!);
      }
    }
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) expect(Object.keys(stub), name).toContain(name);
  });
});
