import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn, signedIn } from "./session";
import { ASK, CHOICES, GAVE_UP, QUESTION, withJourney } from "./journey";
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

// Where screenshots go, when they are asked for (SHOTS=dir).
async function shot(page: Page, name: string, at?: Locator): Promise<void> {
  const dir = process.env.SHOTS;
  if (!dir) return;
  await at?.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/${test.info().project.name}-${name}.png`, fullPage: false });
}

async function toTheTest(page: Page): Promise<void> {
  await send(page, ASK);
  await press(page, card(page, 1, "Describe").getByRole("button", { name: "Make it" }));
  await press(page, card(page, 2, "Steps").getByRole("button", { name: "Looks right" }));
}

test("a failed test heals itself: calm plain lines on its card, then on to Connect, with nothing typed", async ({ context, page }) => {
  await signIn(context);
  const { asked } = await withJourney(context, { heal: "fix" });
  await page.goto("/app/chat");
  await signedIn(page);
  await toTheTest(page);
  const tried = card(page, 4, "Try it");
  const lines = tried.getByRole("list", { name: "What it fixed" });
  await expect(lines).toContainText("Found a problem in step 6 while trying it. Fixing it.", BUILDING);
  await expect(lines).toContainText("Writing step 6 again.", BUILDING);
  await expect(tried.getByRole("status").first()).toHaveText("Fixing it");
  await shot(page, "build-fixing", tried);
  // Never a reason, a review, code, a hold or a box to describe a fix.
  await expect(tried).not.toContainText(/on hold|review|code|didn't pass/i);
  await expect(tried.getByRole("textbox")).toHaveCount(0);
  await expect(lines.getByText("Fixed.", { exact: true })).toBeVisible(BUILDING);
  await expect(card(page, 5, "Connect")).toBeVisible(BUILDING);
  // One Try it card: the test after the repair stays on it.
  await expect(page.getByRole("region", { name: "4. Try it" })).toHaveCount(1);
  // The maker typed one thing: the job.
  expect(asked.filter((a) => a.url === "/api/chat")).toHaveLength(1);
  expect(asked.some((a) => a.url.endsWith("/fix"))).toBe(false);
});

test("asks one plain question in the chat with answers to tap, and carries on with the answer", async ({ context, page }) => {
  await signIn(context);
  const { asked } = await withJourney(context, { heal: "ask" });
  await page.goto("/app/chat");
  await signedIn(page);
  await toTheTest(page);
  await expect(page.getByRole("log").getByText(QUESTION, { exact: true })).toBeVisible(BUILDING);
  await expect(card(page, 4, "Try it").getByRole("status").first()).toHaveText("One question for you");
  const chips = page.getByRole("button", { name: CHOICES[0] });
  await expect(chips).toBeVisible();
  await expect(page.getByRole("button", { name: CHOICES[1] })).toBeVisible();
  await expect(card(page, 4, "Try it")).not.toContainText("stopped at");
  await shot(page, "question", page.getByRole("button", { name: CHOICES[1] }));
  await press(page, chips);
  await expect(page.getByText("Thanks. I'll carry on with that.")).toBeVisible();
  await expect(card(page, 5, "Connect")).toBeVisible(BUILDING);
  expect(asked.filter((a) => a.url === "/api/chat").map((a) => (a.body as { content: string }).content)).toEqual([ASK, CHOICES[0]]);
});

test("gives up in one plain sentence with two choices, never a fix box, and a simpler version works its steps out again", async ({ context, page }) => {
  await signIn(context);
  const { asked } = await withJourney(context, { heal: "giveUp" });
  await page.goto("/app/chat");
  await signedIn(page);
  await toTheTest(page);
  const tried = card(page, 4, "Try it");
  await expect(tried.getByText(GAVE_UP, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(tried.getByRole("textbox")).toHaveCount(0);
  await expect(tried.getByRole("button", { name: "Describe the job differently" })).toBeVisible();
  await expect(tried).toContainText("It tried 3 times to put it right on its own.");
  await expect(tried).not.toContainText(/stopped at|review|code/i);
  await shot(page, "gave-up", tried.getByRole("button", { name: "Describe the job differently" }));
  await press(page, tried.getByRole("button", { name: "Try a simpler version" }));
  await expect(page.getByText("Making a simpler version of it.")).toBeVisible(BUILDING);
  expect(asked.some((a) => a.url === "/api/conversations/c9/journey" && (a.body as { action: string }).action === "simpler")).toBe(true);
});

test("the details view keeps every diagnosis and repair", async ({ context, page }) => {
  await signIn(context);
  await withJourney(context, { heal: "fix" });
  await page.goto("/app/chat");
  await signedIn(page);
  await toTheTest(page);
  await expect(card(page, 5, "Connect")).toBeVisible(BUILDING);
  await page.goto("/app/agents/a9?details=1");
  const history = page.getByRole("region", { name: "How it healed itself" });
  await expect(history).toContainText("Trying it", FIRST_VISIT);
  await expect(history).toContainText('"Write the reminder" didn\'t work on the sample product.');
  await expect(history).toContainText("The step's code was wrong");
  await expect(history).toContainText("Fixed");
  await shot(page, "details-history", history);
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
