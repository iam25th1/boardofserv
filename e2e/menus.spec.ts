import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn, signedIn, withConversations } from "./session";
import { FIRST_VISIT } from "./warm";

// The app's other menus, popovers and dialogs, in Chromium and WebKit at
// desktop and phone width: the top bar's places from the chat, the chat's
// agents popover and the dialogs it opens, the keyboard shortcuts dialog,
// and a rental's cancel dialog (on the development harness's sample data).

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

test.describe("signed in", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
    await withConversations(context);
  });

  for (const place of [
    { name: "Board", path: "/app/board", heading: "The board" },
    { name: "Requests", path: "/app/requests", heading: "Requests" },
    { name: "Your agents", path: "/app/installations", heading: "Running for you" },
  ]) {
    test(`the top bar's "${place.name}" opens its page from the chat`, async ({ page }) => {
      await page.goto("/app/chat");
      await signedIn(page);
      const link = page.getByRole("navigation", { name: "The app" }).filter({ visible: true }).getByRole("link", { name: place.name });
      expect(await reachable(link)).toBe(true);
      await press(page, link);
      await expect(page).toHaveURL(place.path, FIRST_VISIT);
      await expect(page.getByRole("heading", { level: 1, name: place.heading })).toBeVisible();
    });
  }

  async function openAgents(page: Page): Promise<Locator> {
    await page.goto("/app/chat");
    await signedIn(page);
    const pill = page.getByRole("button", { name: "1 agent" });
    await press(page, pill);
    await expect(pill).toHaveAttribute("aria-expanded", "true");
    const pop = page.locator(`[id="${await pill.getAttribute("aria-controls")}"]`);
    await expect(pop).toBeVisible();
    return pop;
  }

  test("the agents popover opens on screen, and each of its controls can be reached", async ({ page }) => {
    const pop = await openAgents(page);
    const controls = [pop.getByRole("textbox", { name: "Search conversations" }), pop.getByRole("button", { name: /^ETH floor watch/ }), pop.getByRole("button", { name: /^Daily Gmail summary/ }), pop.getByRole("button", { name: "+ New agent" })];
    for (const c of controls) expect(await reachable(c)).toBe(true);
    // Rename and Delete show on hover with a mouse, and always on a touch screen.
    if (!test.info().project.use.hasTouch) await pop.getByRole("button", { name: /^ETH floor watch/ }).hover();
    for (const c of [pop.getByRole("button", { name: "Rename ETH floor watch" }), pop.getByRole("button", { name: "Delete ETH floor watch" })]) expect(await reachable(c)).toBe(true);
  });

  test("picking a conversation in the agents popover closes it", async ({ page }) => {
    const pop = await openAgents(page);
    await press(page, pop.getByRole("button", { name: /^Daily Gmail summary/ }));
    await expect(pop).toBeHidden();
    await expect(page.getByRole("button", { name: "1 agent" })).toHaveAttribute("aria-expanded", "false");
  });

  for (const [action, title] of [
    ["Rename", "Rename conversation"],
    ["Delete", "Delete this conversation?"],
  ] as const) {
    test(`${action} in the agents popover opens its dialog, and Cancel closes it`, async ({ page }) => {
      const pop = await openAgents(page);
      if (!test.info().project.use.hasTouch) await pop.getByRole("button", { name: /^ETH floor watch/ }).hover();
      await press(page, pop.getByRole("button", { name: `${action} ETH floor watch` }));
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      const cancel = dialog.getByRole("button", { name: "Cancel" });
      expect(await reachable(cancel)).toBe(true);
      await press(page, cancel);
      await expect(dialog).toBeHidden();
    });
  }

  test("the keyboard shortcuts dialog closes with Escape, and focus goes back to the account button", async ({ page }) => {
    await page.goto("/app/chat");
    await signedIn(page);
    const account = page.getByRole("button", { name: /^Account, @maker_4821/ });
    await press(page, account);
    await press(page, page.getByRole("button", { name: "Keyboard shortcuts" }));
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(account).toBeFocused();
  });
});

test("a rental's cancel dialog: its buttons can be reached, Keep it and Escape close it", async ({ page }) => {
  await page.goto("/demo?market=rental");
  const open = page.getByRole("button", { name: "Cancel", exact: true });
  await press(page, open);
  const dialog = page.getByRole("dialog", { name: /^Cancel / });
  await expect(dialog).toBeVisible();
  for (const name of ["Keep it", "Cancel it"]) expect(await reachable(dialog.getByRole("button", { name }))).toBe(true);
  await press(page, dialog.getByRole("button", { name: "Keep it" }));
  await expect(dialog).toBeHidden();
  await press(page, open);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
