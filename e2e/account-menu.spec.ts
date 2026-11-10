import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn, signedIn, withConversations } from "./session";
import { FIRST_VISIT } from "./warm";

// The account menu, signed in, in Chromium and WebKit at desktop and phone
// width (the projects in playwright.config.ts). Every item is clicked (or
// tapped on a phone) the way a person would, from the chat, where its links
// once went nowhere, and from the board.

const LINKS = [
  { name: "Balance, top up and earnings", path: "/app/wallet", heading: "Your wallet" },
  { name: "Agents you're building", path: "/app/agents", heading: "Agents you make" },
  { name: "Connections: Telegram and Google", path: "/app/connections", heading: "Connections" },
  { name: "Admin", path: "/app/admin", heading: "Admin" },
];

const accountButton = (page: Page) => page.getByRole("button", { name: /^Account, @maker_4821/ });

async function openMenu(page: Page): Promise<Locator> {
  const button = accountButton(page);
  if ((await button.getAttribute("aria-expanded")) !== "true") await press(page, button);
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator(`[id="${await button.getAttribute("aria-controls")}"]`);
  await expect(panel).toBeVisible();
  return panel;
}

// A click with the mouse, or a tap on a touch screen.
async function press(page: Page, target: Locator): Promise<void> {
  if (test.info().project.use.hasTouch) await target.tap();
  else await target.click();
}

// The control itself is what is under its own centre: nothing covers it.
async function onTop(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  });
}

test.beforeEach(async ({ context }) => {
  await signIn(context);
  await withConversations(context);
});

for (const from of ["/app/chat", "/app/board"]) {
  for (const link of LINKS) {
    test(`from ${from}, "${link.name}" opens its page and closes the menu`, async ({ page }) => {
      await page.goto(from);
      await signedIn(page);
      const panel = await openMenu(page);
      const target = panel.getByRole("link", { name: link.name });
      await expect(target).toHaveAttribute("href", link.path);
      expect(await onTop(target)).toBe(true);
      await press(page, target);
      await expect(page).toHaveURL(link.path, FIRST_VISIT);
      await expect(page.getByRole("heading", { level: 1, name: link.heading })).toBeVisible();
      await expect(accountButton(page)).toHaveAttribute("aria-expanded", "false");
    });
  }
}

test("the chat settles, so nothing holds up a move", async ({ page }) => {
  const loops: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("Maximum update depth")) loops.push(m.text());
  });
  await page.goto("/app/chat");
  await signedIn(page);
  await page.waitForTimeout(1500);
  expect(loops).toEqual([]);
});

test("Change opens the handle field, and Escape puts it back", async ({ page }) => {
  await page.goto("/app/board");
  await signedIn(page);
  const panel = await openMenu(page);
  const change = panel.getByRole("button", { name: "Change" });
  expect(await onTop(change)).toBe(true);
  await press(page, change);
  const field = panel.getByRole("textbox", { name: "Your handle" });
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(field).toBeHidden();
  await expect(panel.getByRole("button", { name: "Change" })).toBeVisible();
});

test("Use your own SERV key opens the key field", async ({ page }) => {
  await page.goto("/app/board");
  await signedIn(page);
  const panel = await openMenu(page);
  const use = panel.getByRole("button", { name: "Use your own SERV key" });
  expect(await onTop(use)).toBe(true);
  await press(page, use);
  await expect(panel.getByLabel("Your SERV key")).toBeFocused();
  await press(page, panel.getByRole("button", { name: "Cancel" }));
  await expect(panel.getByRole("button", { name: "Use your own SERV key" })).toBeVisible();
});

test("Keyboard shortcuts opens its dialog on the chat", async ({ page }) => {
  await page.goto("/app/chat");
  await signedIn(page);
  const panel = await openMenu(page);
  const shortcuts = panel.getByRole("button", { name: "Keyboard shortcuts" });
  expect(await onTop(shortcuts)).toBe(true);
  await press(page, shortcuts);
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect(accountButton(page)).toHaveAttribute("aria-expanded", "false");
});

test("Sign out signs out", async ({ page }) => {
  await page.goto("/app/board");
  await signedIn(page);
  const panel = await openMenu(page);
  const out = panel.getByRole("button", { name: "Sign out" });
  expect(await onTop(out)).toBe(true);
  await press(page, out);
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(accountButton(page)).toHaveCount(0);
});

test.describe("by keyboard", () => {
  test.skip(({ isMobile }) => isMobile, "phones have no keyboard to tab with");

  test("Enter opens it, Tab walks its items, Escape closes it and focus goes back", async ({ page, browserName }) => {
    // WebKit on a Mac, like Safari, tabs only to fields unless asked for
    // everything: Option+Tab (or Safari's "Press Tab to highlight each
    // item" setting) moves through buttons and links too.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    await page.goto("/app/chat");
    await signedIn(page);
    const button = accountButton(page);
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    const order = ["Change", "Use your own SERV key", ...LINKS.map((l) => l.name), "Keyboard shortcuts", "Sign out"];
    for (const name of order) {
      await page.keyboard.press(tab);
      await expect(page.locator(":focus")).toHaveAccessibleName(name);
    }
    await page.keyboard.press("Escape");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(button).toBeFocused();
  });

  test("Enter on a link opens its page", async ({ page }) => {
    await page.goto("/app/chat");
    await signedIn(page);
    const button = accountButton(page);
    await button.focus();
    await page.keyboard.press("Enter");
    const panel = page.locator(`[id="${await button.getAttribute("aria-controls")}"]`);
    await panel.getByRole("link", { name: "Agents you're building" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/app/agents", FIRST_VISIT);
    await expect(button).toHaveAttribute("aria-expanded", "false");
  });
});
