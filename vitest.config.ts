import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // JSX compiles with React's automatic runtime, from tsconfig (react-jsx).
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // The model client's pause between tries, none in tests (the retry
    // tests set their own).
    env: { MODEL_RETRY_BACKOFF_MS: "0" },
    // Most files run on their own in-memory Postgres (PGlite, WebAssembly):
    // its migrations take a few seconds, and a test that runs agents' jobs
    // makes a few hundred queries. With the whole suite running at once (a
    // worker per core) beside other work on the machine, vitest's wall
    // clock limits (5 s a test, 10 s a hook) are what failed: the maker's
    // dashboard test and the job tests timed out, the share card test timed
    // out importing its pages, and a PGlite setup ran past its hook's 10 s,
    // with nothing wrong in the code. The limits stay, with room.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Tests run in Node, so the server-only guard (which throws when bundled
      // for the browser) is replaced with an empty module here.
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
});
