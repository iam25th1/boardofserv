import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn, signedIn } from "./session";
import { ASK, FAILED, withJourney } from "./journey";
import { FIRST_VISIT } from "./warm";

// The whole journey in the chat, in Chromium and WebKit at desktop and
// phone width, signed in fresh, with every call answered by e2e/journey.ts
// as the server would: the six stages in order, Change something changing
// the steps in place, a failed test with its fix box, Run it for me, and
// Back from the agent's page to the same chat, where it was.

async function press(page: Page, target: Locator): Promise<void> {
  if (test.info().project.use.hasTouch) await target.tap();
  else await target.click();
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("[data-composer-input]").fill(text);
  await press(page, page.getByRole("button", { name: "Send message" }));
}

const tracker = (page: Page) => page.getByRole("navigation", { name: "Making your agent" });
const at = (page: Page) => tracker(page).locator('[aria-current="step"]');
const card = (page: Page, n: number, name: string) => page.getByRole("region", { name: `${n}. ${name}` });
// Building moves on with each look the chat takes, every two seconds.
const BUILDING = { timeout: 45_000 };

test("a first visit shows one sentence, three jobs to start from and the way ahead, faintly", async ({ context, page }) => {
  await signIn(context);
  await withJourney(context);
  await page.goto("/app/chat");
  await signedIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tell boardofserv a job in your own words, and it makes an agent that does it for you.", FIRST_VISIT);
  await expect(page.getByRole("list", { name: "Jobs to start from" }).getByRole("button")).toHaveCount(3);
  await expect(tracker(page)).toHaveAttribute("data-faint", "true");
  await expect(at(page)).toContainText("Describe");
  // Nothing else competes: no conversations row before the first chat.
  await expect(page.getByRole("button", { name: /^New agent/ })).toHaveCount(0);
});

test("each stage comes in order, Change something changes the steps in place, and Run it for me puts it to work", async ({ context, page }) => {
  await signIn(context);
  const { asked } = await withJourney(context);
  await page.goto("/app/chat");
  await signedIn(page);
  await send(page, ASK);

  // 1 Describe: the reply, then Make it as the only action.
  const describe = card(page, 1, "Describe");
  await expect(describe).toContainText("below your target");
  await expect(page.getByRole("button", { name: "Plan" })).toHaveCount(0);
  await press(page, describe.getByRole("button", { name: "Make it" }));

  // 2 Steps: worked out, then numbered in plain words.
  const steps = card(page, 2, "Steps");
  await expect(at(page)).toContainText("Steps");
  await expect(steps.getByRole("listitem")).toHaveCount(7, BUILDING);
  await expect(steps.getByRole("listitem").first()).toContainText("Read the price");
  const text = (await steps.innerText()).toLowerCase();
  for (const word of ["plan", "code", "decision", "tool", "settings", "draft", "version", "web.fetch", "telegram.ask"]) expect(text, word).not.toContain(word);
  await press(page, steps.getByRole("button", { name: "Change something" }));
  await steps.getByLabel("What should be different?").fill("Put the price in the reminder");
  await press(page, steps.getByRole("button", { name: "Change it" }));
  await expect(steps.getByText("Write the reminder, with the price in it")).toBeVisible(BUILDING);
  await expect(page.getByText('I changed the steps. New or changed: "Write the reminder, with the price in it".')).toBeVisible();
  expect(asked.find((a) => a.url === "/api/agents/a9/fix")?.body).toEqual({ message: "Put the price in the reminder", journey: "change" });

  // 3 Build: step by step, to "Built and checked".
  await press(page, steps.getByRole("button", { name: "Looks right" }));
  const build = card(page, 3, "Build");
  await expect(build.getByText(/^(Writing step \d of 7|Checking step \d)$/)).toBeVisible(BUILDING);
  await expect(card(page, 3, "Build")).toContainText("Built and checked", BUILDING);

  // 4 Try it: its story, passed; then 5 Connect.
  const tried = card(page, 4, "Try it");
  await expect(tried.getByText("Passed", { exact: true })).toBeVisible(BUILDING);
  await expect(tried).toContainText("Passed. It read the page");
  const connect = card(page, 5, "Connect");
  await expect(connect.getByLabel("Your target price")).toHaveValue("50");
  await expect(connect).not.toContainText(/token|password|api key/i);
  await press(page, connect.getByRole("button", { name: "Save and go on" }));

  // 6 Go live: Run it for me, and when it runs next.
  const live = card(page, 6, "Go live");
  await press(page, live.getByRole("button", { name: /Run it for me/ }));
  await expect(live).toContainText("Next run:");
  await expect(live.getByRole("link", { name: "See how it's doing" })).toHaveAttribute("href", "/app/installations/i9");
  expect(asked.filter((a) => a.method === "POST").map((a) => a.url)).toEqual(["/api/chat", "/api/agents", "/api/agents/a9/fix", "/api/agents/a9/build", "/api/conversations/c9/journey", "/api/agents/a9/golive"]);

  // Scrolling up tells the whole story, a card a stage, in order.
  const regions = await page.getByRole("log").getByRole("region").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(regions).toEqual(["1. Describe", "2. Steps", "3. Build", "4. Try it", "5. Connect", "6. Go live"]);
});

test("a failed test shows its one sentence and a box prefilled with it, and Fix it runs it again", async ({ context, page }) => {
  await signIn(context);
  const { asked } = await withJourney(context, { failFirstTest: true });
  await page.goto("/app/chat");
  await signedIn(page);
  await send(page, ASK);
  await press(page, card(page, 1, "Describe").getByRole("button", { name: "Make it" }));
  await press(page, card(page, 2, "Steps").getByRole("button", { name: "Looks right" }));
  const tried = card(page, 4, "Try it");
  await expect(tried.getByText("Didn't pass")).toBeVisible(BUILDING);
  await expect(tried.getByText(FAILED, { exact: true }).first()).toBeVisible();
  const box = tried.getByLabel("Say what's wrong, in your own words");
  await expect(box).toHaveValue(FAILED);
  await box.fill("The reminder should use the price it read");
  await press(page, tried.getByRole("button", { name: "Fix it" }));
  // Only what it needs runs again: the steps, the changed step, the test.
  await expect(card(page, 5, "Connect")).toBeVisible(BUILDING);
  expect(asked.find((a) => a.url === "/api/agents/a9/fix")?.body).toEqual({ message: "The reminder should use the price it read", journey: "fix" });
  // The failed test stays in the story above, as it was.
  await expect(page.getByRole("region", { name: "4. Try it" }).first()).toContainText("Didn't pass");
});

test("Back from the agent's page returns to the same chat, where it was", async ({ context, page }) => {
  await signIn(context);
  await withJourney(context);
  await page.goto("/app/chat");
  await signedIn(page);
  await send(page, ASK);
  await press(page, card(page, 1, "Describe").getByRole("button", { name: "Make it" }));
  const steps = card(page, 2, "Steps");
  await expect(steps.getByRole("button", { name: "Looks right" })).toBeVisible(BUILDING);
  await expect(page).toHaveURL(/\/app\/chat\?c=c9$/);
  // To the agent's page by its Details link, in the developer view, and Back.
  await press(page, steps.getByRole("link", { name: "Details" }));
  await expect(page).toHaveURL(/\/app\/agents\/a9\?details=1$/, FIRST_VISIT);
  await expect(page.getByRole("switch", { name: "Show details" })).toHaveAttribute("aria-checked", "true");
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/chat\?c=c9$/);
  await expect(card(page, 2, "Steps").getByRole("button", { name: "Looks right" })).toBeVisible(FIRST_VISIT);
  // Scrolled up to the start, away to the board, and Back: still at the
  // start, not the latest message.
  const log = page.getByRole("log");
  await log.evaluate((el) => el.scrollTo({ top: 0 }));
  await expect.poll(() => log.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(40);
  await page.waitForTimeout(300);
  await press(page, page.getByRole("link", { name: "Board", exact: true }));
  await expect(page).toHaveURL(/\/app\/board/, FIRST_VISIT);
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/chat\?c=c9$/);
  await expect(card(page, 2, "Steps")).toBeVisible(FIRST_VISIT);
  await page.waitForTimeout(500);
  expect(await log.evaluate((el) => el.scrollTop)).toBe(0);
});
