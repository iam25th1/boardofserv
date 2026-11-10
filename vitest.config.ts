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
