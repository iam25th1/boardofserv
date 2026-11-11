import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn, signedIn } from "./session";
import { AGENT_ID, HELD, STORY, withHackathon } from "./agent";
import { FIRST_VISIT } from "./warm";

// Making an agent simply, in Chromium and WebKit at desktop and phone
// width, signed in, with the hackathon submission checker answered locally
// (e2e/agent.ts): New agent in view on the chat, an agent made before the
// chat had its stages picking up at its steps, and the agent's plain page,
// its problem fixed with one button and its details a switch away.

async function press(page: Page, target: Locator): Promise<void> {
  if (test.info().project.use.hasTouch) await target.tap();
  else await target.click();
}

// On screen, and the top element at its own centre: nothing covers it.
async function reachable(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.bottom > innerHeight || r.top < 0 || r.right > innerWidth || r.left < 0) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  });
}

async function openChat(page: Page): Promise<void> {
  await page.goto("/app/chat");
  await signedIn(page);
  await press(page, page.getByRole("button", { name: "1 agent" }));
  await press(page, page.getByRole("button", { name: /^Hackathon Submission Checker/ }));
}

test("the chat always has New agent in view, and it starts a new chat", async ({ context, page }) => {
  await signIn(context);
  await withHackathon(context);
  await openChat(page);
  await expect(page.getByRole("log")).toBeVisible();
  const button = page.getByRole("button", { name: /^New agent/ });
  expect(await reachable(button)).toBe(true);
  await press(page, button);
  await expect(page.getByRole("log")).toHaveCount(0);
  await expect(button).toBeVisible();
});

test("an agent made before the stages picks up at its steps, with Looks right and Details", async ({ context, page }) => {
  await signIn(context);
  await withHackathon(context);
  await openChat(page);
  const steps = page.getByRole("region", { name: "2. Steps" });
  await expect(steps.getByRole("listitem")).toHaveCount(5);
  await expect(steps.getByRole("listitem").first()).toContainText("Read the submissions sheet and pick out the ones not checked yet");
  await expect(steps.getByRole("button", { name: "Looks right" })).toBeVisible();
  await expect(steps.getByRole("link", { name: "Details" })).toHaveAttribute("href", `/app/agents/${AGENT_ID}?details=1`);
  // The old card's buttons are gone: the stages are the way on.
  for (const name of ["Plan", "Test it", "Fix it", "Publish"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Making your agent" }).locator('[aria-current="step"]')).toContainText("Steps");
});

test("the agent page is plain until Show details, which shows everything", async ({ context, page }) => {
  await signIn(context);
  const { asked } = await withHackathon(context);
  await page.goto(`/app/agents/${AGENT_ID}`);
  await signedIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Hackathon Submission Checker" })).toBeVisible(FIRST_VISIT);
  const steps = page.getByRole("heading", { name: "Its steps" }).locator("..").getByRole("listitem");
  await expect(steps).toHaveCount(5);
  await expect(steps.first()).toContainText("Read the submissions sheet and pick out the ones not checked yet");
  // No names of values or tools, no step kinds and no JSON with details off.
  const text = (await page.getByRole("main").innerText()).toLowerCase();
  for (const word of ["sheets.read", "sheets.update", "telegram.send", "submissions_sheet", "status_updates", "{", "decision", "test bench"]) expect(text, word).not.toContain(word);
  await press(page, page.getByRole("button", { name: "Test it" }));
  await expect(page.getByText(STORY)).toBeVisible();
  // Show details: the full view, kept for this agent only.
  await press(page, page.getByRole("switch", { name: "Show details" }));
  await expect(page.getByRole("heading", { name: "Test bench" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Test bench" })).toBeVisible(FIRST_VISIT);
  expect(asked.find((a) => a.url === "/api/account/details")).toBeUndefined();
});

test("a problem shows as one sentence, and Fix this has SERV fix it with no typing", async ({ context, page }) => {
  await signIn(context);
  const { asked } = await withHackathon(context, { problem: HELD });
  await page.goto(`/app/agents/${AGENT_ID}`);
  await signedIn(page);
  await expect(page.getByText(HELD!.text)).toBeVisible(FIRST_VISIT);
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
  await press(page, page.getByRole("button", { name: "Fix this" }));
  await expect(page.getByText(HELD!.text)).toHaveCount(0);
  expect(asked.find((a) => a.url === `/api/agents/${AGENT_ID}/fix`)?.body).toEqual({ step: "tally" });
});
