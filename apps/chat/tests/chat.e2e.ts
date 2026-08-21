import { expect, test } from "@playwright/test";

test("chat page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("textbox")).toBeVisible();
});

test("development login tool is available on the login page", async ({
  page,
}) => {
  await page.goto("/login");

  const devLogin = page.getByRole("link", { name: "Dev login" });
  await expect(devLogin).toBeVisible();
  await expect(devLogin).toHaveAttribute("href", "/api/dev-login");
});

test("the chat layout does not warn about its own panel sizes", async ({
  page,
}) => {
  // `ChatLayoutSecondary` and `ChatLayoutHandle` render nothing while the
  // artifact panel is closed, so the group holds ONE panel. Declaring
  // `defaultSize={65}` there made react-resizable-panels warn and rescale on
  // every clean load. The listener must be attached BEFORE goto or the warning
  // (emitted during the first commit) is missed.
  //
  // The library's other warning — "Panel id and order props recommended when
  // panels are dynamically rendered" — is deliberately NOT asserted here: it
  // lives behind `prevPanelIds.length > 0 && !areEqual(...)`, so it cannot fire
  // until a panel registers or unregisters, i.e. until the artifact panel opens.
  // Asserting its absence on a plain load would pass with or without the fix.
  const warnings: string[] = [];
  page.on("console", (message) => {
    warnings.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByRole("textbox")).toBeVisible();

  expect(
    warnings.filter((text) => text.includes("Invalid layout total size"))
  ).toEqual([]);
});
