import type { FullConfig } from "@playwright/test";

// The dev server builds each page the first time it is asked for, which can
// take longer than a test waits for a page to show. Every page the tests
// open is asked for once here, before they start.
const PAGES = ["/", "/about", "/terms", "/privacy", "/support", "/everything", "/login", "/app/chat", "/app/board", "/app/requests", "/app/installations", "/app/wallet", "/app/agents", "/app/connections", "/app/admin", "/demo?market=rental"];

export default async function warm(config: FullConfig): Promise<void> {
  const base = config.projects[0]?.use.baseURL;
  if (!base) return;
  for (const path of PAGES) await fetch(base + path).catch(() => undefined);
}
