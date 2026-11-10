// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/backup-db.sh with a stand-in docker on PATH: its arguments, the
// dated dump, keeping the newest N, failing without keeping anything, and
// that it only ever inspects the container and runs pg_dump in it (never
// stops, starts or restarts anything) and prints no secret.

const SCRIPT = join(process.cwd(), "scripts/backup-db.sh");
let home: string;
let bin: string;
let calls: string;

function fakeDocker(o: { running?: boolean; dumpFails?: boolean } = {}) {
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
echo "$@" >> "${calls}"
if [ "$1" = "inspect" ]; then echo ${o.running === false ? "false" : "true"}; exit 0; fi
if [ "$1" = "exec" ]; then ${o.dumpFails ? "echo 'pg_dump: error' >&2; exit 1" : "printf 'PGDMP fake dump'"}; exit 0; fi
exit 9
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
}

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [SCRIPT, ...args], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bos-backup-"));
  bin = join(home, "bin");
  spawnSync("mkdir", ["-p", bin]);
  calls = join(home, "docker-calls.txt");
  writeFileSync(calls, "");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("the backup script", () => {
  it("takes only the arguments it knows, and says what they are", () => {
    expect(run(["--help"]).status).toBe(0);
    expect(run(["--help"]).stdout).toMatch(/--keep 30/);
    for (const bad of [["--keep", "0"], ["--keep", "abc"], ["--keep", "400"], ["--keep"], ["--dir"], ["--dir", "/"], ["--dir", "/etc/x"], ["--container", "x;rm -rf /"], ["--wipe"]]) {
      const r = run(bad);
      expect(r.status, bad.join(" ")).toBe(2);
      expect(r.stderr, bad.join(" ")).toMatch(/^backup: /);
    }
  });

  it("says what it would do on a dry run, and does nothing", () => {
    fakeDocker();
    const r = run(["--dry-run", "--keep", "3"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/would dump database boardofserv from container boardofserv-db to .*\/boardofserv-backups\/boardofserv-\d{8}-\d{6}\.dump/);
    expect(r.stdout).toMatch(/would keep the newest 3/);
    expect(existsSync(join(home, "boardofserv-backups"))).toBe(false);
    expect(readFileSync(calls, "utf8")).toBe("");
  });

  it("writes a dated dump only it can read, and keeps the newest 14 unless told otherwise", () => {
    fakeDocker();
    const dir = join(home, "boardofserv-backups");
    spawnSync("mkdir", ["-p", dir]);
    for (let d = 1; d <= 15; d++) writeFileSync(join(dir, `boardofserv-202601${String(d).padStart(2, "0")}-000000.dump`), "old");
    writeFileSync(join(dir, "notes.txt"), "mine");
    const r = run([], { PGPASSWORD: "not-to-be-printed", TREASURY_PRIVATE_KEY: "0xsecret" });
    expect(r.status, r.stderr).toBe(0);
    const dumps = readdirSync(dir).filter((f) => f.endsWith(".dump")).sort();
    expect(dumps).toHaveLength(14);
    // The oldest two went; the new one is there, with the dump in it.
    expect(dumps[0]).toBe("boardofserv-20260103-000000.dump");
    const fresh = dumps.at(-1)!;
    expect(fresh).toMatch(/^boardofserv-\d{8}-\d{6}\.dump$/);
    expect(readFileSync(join(dir, fresh), "utf8")).toBe("PGDMP fake dump");
    expect(statSync(join(dir, fresh)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Other files are left alone; no secret is printed.
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(r.stdout + r.stderr).not.toMatch(/not-to-be-printed|0xsecret/);
    expect(r.stdout).toMatch(/removed 2 older/);
    // It only looked at the container and dumped from it.
    const used = readFileSync(calls, "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
    expect(used).toEqual(["inspect", "exec"]);
    expect(readFileSync(calls, "utf8")).toMatch(/exec boardofserv-db pg_dump -U boardofserv -d boardofserv --format=custom --no-owner/);
    // --keep 2 trims to two.
    expect(run(["--keep", "2"]).status).toBe(0);
    expect(readdirSync(dir).filter((f) => f.endsWith(".dump"))).toHaveLength(2);
  });

  it("keeps nothing when the dump fails, and starts nothing when the container is down", () => {
    fakeDocker({ dumpFails: true });
    const r = run(["--dir", join(home, "b")]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/pg_dump failed; nothing was kept/);
    expect(readdirSync(join(home, "b"))).toEqual([]);
    fakeDocker({ running: false });
    writeFileSync(calls, "");
    const down = run(["--dir", join(home, "c")]);
    expect(down.status).toBe(2);
    expect(down.stderr).toMatch(/isn't running .* this script starts nothing/);
    expect(readFileSync(calls, "utf8").trim().split("\n").map((l) => l.split(" ")[0])).toEqual(["inspect"]);
  });
});
