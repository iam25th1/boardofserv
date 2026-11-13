import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn, signedIn } from "./session";

// Connecting Typeform from the chat's ask, in Chromium and WebKit at
// desktop and phone width, the app's API answered here: the Connect
// Typeform link opens Connections at the Typeform card, the pasted token
// goes to the app once, and the page goes back to the same chat. A return
// address off the app is never followed.

async function press(page: Page, target: Locator): Promise<void> {
  if (test.info().project.use.hasTouch) await target.tap();
  else await target.click();
}

async function withTypeform(page: Page): Promise<{ sent: unknown[] }> {
  const state = { sent: [] as unknown[], linked: false };
  await page.context().route("**/api/connections", (route) =>
    route.fulfill({
      json: {
        connections: state.linked ? [{ provider: "typeform", name: "Typeform", label: "Typeform (sample)", connectedAt: new Date().toISOString(), lastUsedAt: null, usedBy: [] }] : [],
        available: { telegram: true, google: true, typeform: true },
      },
    }),
  );
  await page.context().route("**/api/connections/typeform", async (route) => {
    state.sent.push(route.request().postDataJSON());
    state.linked = true;
    await route.fulfill({ json: { connected: true, label: "Typeform (sample)" } });
  });
  return state;
}

test("Connect Typeform takes the token once and goes back to the same chat", async ({ context, page }) => {
  await signIn(context);
  const typeform = await withTypeform(page);
  await page.goto(`/app/connections?connect=typeform&back=${encodeURIComponent("/app/chat?c=c1")}`);
  await signedIn(page);
  const field = page.getByLabel("Your Typeform personal token");
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("type", "password");
  await field.fill("tfp_e2e_made_up_token");
  await press(page, page.getByRole("button", { name: "Connect Typeform" }));
  await page.waitForURL(/\/app\/chat\?c=c1$/);
  expect(typeform.sent).toEqual([{ token: "tfp_e2e_made_up_token" }]);
});

test("a return address off the app is never followed", async ({ context, page }) => {
  await signIn(context);
  const typeform = await withTypeform(page);
  await page.goto(`/app/connections?connect=typeform&back=${encodeURIComponent("https://elsewhere.example/app/x")}`);
  await signedIn(page);
  await page.getByLabel("Your Typeform personal token").fill("tfp_e2e_made_up_token");
  await press(page, page.getByRole("button", { name: "Connect Typeform" }));
  await expect(page.getByText("Typeform (sample)")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/app/connections");
  expect(typeform.sent).toHaveLength(1);
});
