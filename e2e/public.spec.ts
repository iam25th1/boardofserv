import { expect, test, type Locator, type Page } from "@playwright/test";
import { signedOut } from "./session";

// The public pages, signed out, in Chromium and WebKit at desktop and phone
// width: the footer's button to the whole explainer on every one of them,
// by pointer and by keyboard; the explainer's contents jumping to its
// parts; its parts easing in as they scroll into view, or simply there
// with reduced motion; and nothing wider than a phone's screen.

const PUBLIC = ["/", "/about", "/terms", "/privacy", "/support", "/everything"];

async function press(page: Page, target: Locator): Promise<void> {
  if (test.info().project.use.hasTouch) await target.tap();
  else await target.click();
}

const guide = (page: Page) => page.getByRole("contentinfo").getByRole("link", { name: "Everything you need to know" });
const part = (page: Page, id: string) => page.locator(`section[aria-labelledby="${id}"]`);

test.beforeEach(async ({ context }) => {
  await signedOut(context);
});

for (const path of PUBLIC) {
  test(`the footer's button on ${path} opens the explainer`, async ({ page }) => {
    await page.goto(path);
    const button = guide(page);
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("href", "/everything");
    if (path === "/everything") {
      await expect(button).toHaveAttribute("aria-current", "page");
      return;
    }
    await press(page, button);
    await expect(page).toHaveURL("/everything");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Everything you need to know");
  });
}

test("the footer's button works by keyboard", async ({ page, browserName }) => {
  test.skip(Boolean(test.info().project.use.hasTouch), "Phones have no Tab key.");
  // WebKit, like Safari, skips links on Tab unless Option is held.
  const back = browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
  await page.goto("/about");
  const footer = page.getByRole("contentinfo");
  await footer.getByRole("link", { name: "The board" }).focus();
  await page.keyboard.press(back);
  await expect(guide(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/everything");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Everything you need to know");
});

test("the explainer's contents jump to each part", async ({ page }) => {
  await page.goto("/everything");
  const contents = page.getByRole("navigation", { name: "Contents" });
  await press(page, contents.getByRole("link", { name: "The trust score: a credit score for AI" }));
  await expect(page).toHaveURL("/everything#trust-score");
  await expect(page.getByRole("heading", { level: 2, name: "The trust score: a credit score for AI" })).toBeInViewport();
  await expect(part(page, "trust-score")).toHaveCSS("opacity", "1");
});

test("the explainer's parts ease in as they come into view, and stay", async ({ page }) => {
  await page.goto("/everything");
  // The partners' drawings draw once as they come into view, and rest with
  // every stroke whole (anime.js draws a stroke with its dash: a first
  // length of 0 is not drawn yet). The last is far below at first.
  const drawings = part(page, "under-the-hood").locator("svg");
  await expect(drawings).toHaveCount(4);
  const dashes = (svg: Locator) => svg.evaluate((el) => [...el.querySelectorAll("[data-draw]")].map((s) => parseFloat(s.getAttribute("stroke-dasharray") ?? "NaN")));
  await expect.poll(async () => (await dashes(drawings.last())).every((d) => d === 0)).toBe(true);
  const last = part(page, "where-we-are");
  // Far below the screen at first: not shown yet.
  await expect(last).toHaveCSS("opacity", "0");
  await last.scrollIntoViewIfNeeded();
  await expect(last).toHaveCSS("opacity", "1");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(last).toHaveCSS("opacity", "1");
  for (const svg of await drawings.all()) {
    await svg.scrollIntoViewIfNeeded();
    await expect.poll(async () => (await dashes(svg)).every((d) => d > 0)).toBe(true);
  }
});

test("with reduced motion, the explainer is all there at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/everything");
  for (const id of ["plain-words", "under-the-hood", "why-serv", "where-we-are"]) await expect(part(page, id)).toHaveCSS("opacity", "1");
  // The drawings are whole as they are: never dashed for drawing.
  const strokes = part(page, "under-the-hood").locator("[data-draw]");
  expect(await strokes.count()).toBeGreaterThan(10);
  expect(await strokes.evaluateAll((all) => all.filter((s) => s.hasAttribute("stroke-dasharray")).length)).toBe(0);
});

test("the explainer is no wider than the screen", async ({ page }) => {
  await page.goto("/everything");
  // Down to the bottom, so every part has come in.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(part(page, "where-we-are")).toHaveCSS("opacity", "1");
  const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: document.documentElement.clientWidth }));
  expect(width.page).toBeLessThanOrEqual(width.screen);
  // On a phone, the comparison is two lists; on a wide screen, a table.
  const phone = Boolean(test.info().project.use.isMobile);
  await expect(page.getByRole("table")).toBeVisible({ visible: !phone });
  await expect(page.getByRole("heading", { level: 3, name: "A boardofserv agent" })).toBeVisible({ visible: phone });
});
