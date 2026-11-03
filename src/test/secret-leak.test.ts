import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// This test fails if a secret could reach the browser bundle or a committed
// file. It enforces three things:
//   1. No Client Component ("use client") imports a server-only module or reads
//      a server secret env var. That is what keeps secrets out of the bundle.
//   2. No tracked file contains a secret-shaped string, and the env files that
//      hold real secrets are not tracked.
//   3. If a production client build and real secrets are both present, none of
//      the secret values appear in the built client assets.

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

const SERVER_MODULES = ["lib/crypto", "lib/openserv", "lib/model", "lib/demoModel", "lib/sketchStore", "lib/helpers", "lib/leakGuard", "lib/privy", "lib/db", "lib/session", "lib/auth-route", "lib/users", "lib/payments/boot", "lib/payments/ledger"];
const SERVER_SECRET_ENVS = ["PRIVY_APP_SECRET", "OPENSERV_KEY_ENC_KEY", "SERV_API_KEY", "FALLBACK_API_KEY", "DATABASE_URL", "TREASURY_PRIVATE_KEY"];

function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.(ts|tsx)$/.test(d.name))
    .map((d) => join(d.parentPath ?? (d as unknown as { path: string }).path, d.name));
}

describe("secrets never reach the client", () => {
  const files = walk(SRC);

  it("no Client Component imports a server-only module or reads a server secret", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.includes("/test/")) continue;
      const text = readFileSync(file, "utf8");
      const isClient = /^\s*["']use client["']/m.test(text);
      if (!isClient) continue;
      for (const mod of SERVER_MODULES) {
        if (new RegExp(`from ["']@/${mod}["']|from ["'].*${mod.replace("lib/", "")}["']`).test(text) && text.includes(mod)) {
          offenders.push(`${file} imports server module ${mod}`);
        }
      }
      for (const env of SERVER_SECRET_ENVS) {
        if (text.includes(`process.env.${env}`)) offenders.push(`${file} reads ${env}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no source file contains a secret-shaped string", () => {
    const shapes = [/0x[0-9a-fA-F]{64}\b/, /\b[0-9a-f]{40,}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/];
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith("secret-leak.test.ts")) continue;
      const text = readFileSync(file, "utf8");
      for (const re of shapes) if (re.test(text)) offenders.push(`${file} matches ${re}`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("real secret files are not tracked by git", () => {
    let tracked = "";
    try {
      tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" });
    } catch {
      return; // not a git repo in this environment, skip
    }
    const lines = tracked.split("\n");
    expect(lines).not.toContain(".env");
    expect(lines).not.toContain(".env.local");
    for (const l of lines) expect(l).not.toMatch(/\.env\.(local|development|production)$/);
  });

  it("no secret value appears in a built client bundle", () => {
    const staticDir = join(ROOT, ".next", "static");
    if (!existsSync(staticDir)) return; // no client build yet, nothing to scan
    const secrets = SERVER_SECRET_ENVS.map((e) => process.env[e]).filter((v): v is string => typeof v === "string" && v.length >= 8);
    if (secrets.length === 0) return;
    const assets = walk(staticDir).concat(
      readdirSync(staticDir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile() && /\.(js|css|json)$/.test(d.name))
        .map((d) => join(d.parentPath ?? (d as unknown as { path: string }).path, d.name)),
    );
    const offenders: string[] = [];
    for (const asset of assets) {
      const text = readFileSync(asset, "utf8");
      for (const s of secrets) if (text.includes(s)) offenders.push(asset);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
