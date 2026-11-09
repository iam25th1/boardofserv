// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Fonts are in the repo and loaded locally: no build or deploy fetches one
// from Google. The unit checks run with every test run; the build checks
// run in `npm run test:build`, right after `next build`, on its output.

const ROOT = join(__dirname, "..", "..");
const FONTS = join(ROOT, "src", "app", "fonts");
const GOOGLE = /fonts\.(googleapis|gstatic)\.com/;

function walk(dir: string, keep: (f: string) => boolean, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(f)) out.push(p);
  }
  return out;
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("the app's fonts", () => {
  it("come from files in the repo, never from Google", () => {
    const sources = walk(join(ROOT, "src"), (f) => /\.(tsx?|css|mjs)$/.test(f) && !/\.test\./.test(f));
    const google = sources.filter((p) => /next\/font\/google/.test(readFileSync(p, "utf8")) || GOOGLE.test(readFileSync(p, "utf8")));
    expect(google.map((p) => relative(ROOT, p))).toEqual([]);
    const layout = readFileSync(join(ROOT, "src", "app", "layout.tsx"), "utf8");
    expect(layout).toContain('from "next/font/local"');
    expect(layout).toContain('src: "./fonts/onest-latin.woff2"');
    expect(layout).toContain('src: "./fonts/caveat-latin.woff2"');
  });

  it("are real woff2 files, each with its licence", () => {
    for (const f of ["onest-latin.woff2", "caveat-latin.woff2"]) {
      const bytes = readFileSync(join(FONTS, f));
      expect(bytes.subarray(0, 4).toString("latin1"), f).toBe("wOF2");
      expect(bytes.length).toBeGreaterThan(10_000);
    }
    for (const f of ["OFL-Onest.txt", "OFL-Caveat.txt"]) expect(readFileSync(join(FONTS, f), "utf8")).toContain("SIL Open Font License, Version 1.1");
  });
});

describe.runIf(process.env.CHECK_BUILD)("the build's fonts", () => {
  const next = join(ROOT, ".next");

  it("are the repo's own files, served from the app", () => {
    expect(existsSync(next)).toBe(true);
    const media = walk(join(next, "static", "media"), (f) => f.endsWith(".woff2")).map(sha);
    for (const f of ["onest-latin.woff2", "caveat-latin.woff2"]) expect(media, f).toContain(sha(join(FONTS, f)));
  });

  it("never point pages or styles at Google", () => {
    // Next's own runtime mentions Google's font hosts in its code; what the
    // app serves (its styles and its prerendered pages) must not load from them.
    const built = walk(next, (f) => /\.(css|html|rsc)$/.test(f)).filter((p) => !p.includes(join(next, "cache")));
    expect(built.length).toBeGreaterThan(10);
    const google = built.filter((p) => GOOGLE.test(readFileSync(p, "utf8")));
    expect(google.map((p) => relative(next, p))).toEqual([]);
    // Every font face with a file loads it from the app (the fallbacks use local fonts).
    const faces = built.filter((p) => p.endsWith(".css")).flatMap((p) => readFileSync(p, "utf8").match(/@font-face\{[^}]*\}/g) ?? []).filter((f) => f.includes("url("));
    expect(faces.length).toBeGreaterThanOrEqual(2);
    for (const f of faces) expect(f).toMatch(/url\(\/_next\/static\/media\/[^)]+\.woff2\)/);
  });
});
