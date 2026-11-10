import { defineConfig, devices } from "@playwright/test";
import { E2E_PRIVY_APP_ID } from "./e2e/session";

// Clicks in real browser engines: Chromium, and WebKit (Safari's engine), at
// desktop and phone width. The app runs on its dev server with a made-up
// Privy app id; e2e/session.ts answers Privy and the account for it, so no
// key is needed and nothing leaves the machine. E2E_BASE_URL points the
// tests at a server that is already running instead.
const PORT = 3100;
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/warm.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: "list",
  // The dev server compiles each page the first time it is asked for.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } } },
    { name: "chromium-phone", use: { ...devices["Pixel 7"] } },
    { name: "webkit-phone", use: { ...devices["iPhone 14"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next dev -p ${PORT}`,
        url: `${baseURL}/login`,
        timeout: 120_000,
        reuseExistingServer: false,
        // The app's own API has no database here, and every call the tests
        // don't answer says so on stderr. A failure keeps its trace instead.
        stderr: "ignore",
        env: { NEXT_PUBLIC_PRIVY_APP_ID: E2E_PRIVY_APP_ID, NEXT_TELEMETRY_DISABLED: "1" },
      },
});
