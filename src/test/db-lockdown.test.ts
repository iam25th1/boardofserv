// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error scripts/db-lockdown-env.mjs is plain JavaScript, without types
import { describeUrl, findDatabaseUrl, passwordSql, pierMask, replaceDatabaseUrl, withPassword } from "../../scripts/db-lockdown-env.mjs";

// scripts/db-lockdown.sh, without Docker or a database: its dry run, and
// --apply refusing to start without the exact phrase. Every tool it could
// reach for is a stub that records the call and fails, so the tests show it
// called none of them.

const ROOT = join(__dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "db-lockdown.sh");
const TOOLS = ["docker", "node", "openssl", "psql", "pg_dump", "pg_restore", "pier", "curl", "lsof"];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[], input = "") {
  const dir = mkdtempSync(join(tmpdir(), "bos-lockdown-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const calls = join(dir, "calls.log");
  for (const d of [home, bin]) spawnSync("mkdir", ["-p", d]);
  for (const tool of TOOLS) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\nexit 99\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const r = spawnSync("bash", [SCRIPT, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, NODE_ENV: "test" },
    input,
    encoding: "utf8",
    timeout: 20_000,
  });
  return {
    status: r.status,
    out: r.stdout,
    err: r.stderr,
    home,
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
  };
}

describe("db-lockdown.sh dry run", () => {
  it("prints every step in order and changes nothing", () => {
    const r = run([]);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out).toContain("dry run. Nothing is changed.");

    const step = (n: number) => r.out.indexOf(`\n  ${n}. `);
    const steps = [1, 2, 3, 4, 5, 6, 7].map(step);
    expect(steps.every((i) => i > 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    const text = (n: number) => r.out.slice(steps[n - 1], n < 7 ? steps[n] : undefined).replace(/\s+/g, " ");

    expect(text(1)).toContain("type LOCK DOWN");
    expect(text(1)).toContain("nothing changed");
    expect(text(2)).toContain("docker exec boardofserv-db pg_dump -Fc");
    expect(text(2)).toContain(join(r.home, ".boardofserv", "backups"));
    expect(text(2)).toContain("folder 0700, file 0600");
    expect(text(2)).toContain("stops if pg_dump fails, the file is empty");
    expect(text(2)).toContain("counts the rows of every table");
    expect(text(3)).toContain("openssl rand -hex 32");
    expect(text(3)).toContain("ALTER ROLE");
    expect(text(3)).toContain("never printed, logged or put on a command line");
    expect(text(4)).toContain("rename it boardofserv-db-pre-lockdown (kept, stopped)");
    expect(text(4)).toContain("same image and the same named volume");
    expect(text(4)).toContain("published on 127.0.0.1:5433 only");
    expect(text(5)).toContain("count the rows again and compare them with step 2");
    expect(text(6)).toContain(join(ROOT, ".env.local"));
    expect(text(6)).toContain("(that line only)");
    expect(text(6)).toContain("boardofserv Pier service's env (that value only");
    expect(text(7)).toContain("redeploy boardofserv in Pier and start the dev server again");
    expect(text(7)).toContain("It does neither itself.");
    const all = r.out.replace(/\s+/g, " ");
    expect(all).toContain("prints how to roll back: the backup path and the old container's settings");
    expect(all).toContain("never deletes the backup");

    // Nothing called, nothing written, no secret to show.
    expect(r.calls).toBe("");
    expect(existsSync(join(r.home, ".boardofserv"))).toBe(false);
    expect(r.out).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("--apply stops at the prompt unless LOCK DOWN is typed exactly", () => {
    for (const input of ["", "\n", "lock down\n", "LOCK DOWN \n", "LOCKDOWN\n", "yes\n"]) {
      const r = run(["--apply"], input);
      expect(r.status).toBe(1);
      expect(r.out).toContain("Type LOCK DOWN to go on:");
      expect(r.out).toContain("Not confirmed. Nothing was changed.");
      expect(r.calls).toBe("");
      expect(existsSync(join(r.home, ".boardofserv"))).toBe(false);
    }
  });

  it("anything but no flag or --apply is a usage error", () => {
    for (const args of [["--yes"], ["apply"], ["--apply", "--force"]]) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.err).toContain("usage: bash scripts/db-lockdown.sh [--apply]");
      expect(r.calls).toBe("");
    }
  });
});

describe("db-lockdown-env.mjs, which handles DATABASE_URL", () => {
  const URL_NOW = "postgres://boardofserv:boardofserv@localhost:5433/boardofserv";
  const ENV = ["# local", "NEXT_PUBLIC_PRIVY_APP_ID=abc", `DATABASE_URL=${URL_NOW}`, "TREASURY_ADDRESS=0x1", ""].join("\n");

  it("changes the DATABASE_URL line and no other", () => {
    const next = replaceDatabaseUrl(ENV, "postgres://boardofserv:new@localhost:5433/boardofserv");
    const a = ENV.split("\n");
    const b = next.split("\n");
    expect(b).toHaveLength(a.length);
    expect(a.map((line, i) => line === b[i])).toEqual([true, true, false, true, true]);
    expect(b[2]).toBe("DATABASE_URL=postgres://boardofserv:new@localhost:5433/boardofserv");
  });

  it("keeps the line's quotes, export and line ending", () => {
    expect(replaceDatabaseUrl(`export DATABASE_URL="${URL_NOW}"\r\nX=1\r\n`, "postgres://u:p@h:1/d")).toBe('export DATABASE_URL="postgres://u:p@h:1/d"\r\nX=1\r\n');
    expect(replaceDatabaseUrl(`DATABASE_URL='${URL_NOW}'\n`, "postgres://u:p@h:1/d")).toBe("DATABASE_URL='postgres://u:p@h:1/d'\n");
  });

  it("refuses an env file without exactly one DATABASE_URL line", () => {
    expect(() => findDatabaseUrl("X=1\n# DATABASE_URL=postgres://a\n")).toThrow("expected one DATABASE_URL line, found 0");
    expect(() => findDatabaseUrl(`DATABASE_URL=${URL_NOW}\nDATABASE_URL=${URL_NOW}\n`)).toThrow("found 2");
  });

  it("swaps only the password, and describes the URL without it", () => {
    const next = withPassword(`${URL_NOW}?sslmode=disable`, "a".repeat(64));
    expect(next).toBe(`postgres://boardofserv:${"a".repeat(64)}@localhost:5433/boardofserv?sslmode=disable`);
    expect(describeUrl(next)).toEqual({ user: "boardofserv", host: "localhost", port: "5433", db: "boardofserv" });
    expect(JSON.stringify(describeUrl(next))).not.toContain("aaaa");
    expect(() => withPassword("mysql://u:p@h/d", "x")).toThrow("not a postgres:// URL");
  });

  it("writes SQL that keeps the statement out of the server log and quotes the role and password", () => {
    const sql = passwordSql("postgres://we%22ird:it's%25@localhost:5433/db");
    const lines = sql.trim().split("\n");
    expect(lines.slice(0, 3)).toEqual(["SET log_statement = 'none';", "SET log_min_error_statement = 'panic';", "SET log_min_duration_statement = -1;"]);
    expect(lines.at(-1)).toBe(`ALTER ROLE "we""ird" WITH PASSWORD 'it''s%';`);
  });

  it("matches the masked preview Pier shows for a value", () => {
    expect(pierMask(URL_NOW)).toBe(`po${"•".repeat(12)}rv`);
    expect(pierMask("short")).toBe("•".repeat(5));
    expect(pierMask("")).toBe("");
  });
});
