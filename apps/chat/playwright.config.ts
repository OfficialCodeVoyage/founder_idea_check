import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import { config } from "dotenv";

/**
 * Both layouts, resolved from THIS FILE rather than the working directory —
 * playwright may be invoked from the app or the repo root, and a bare
 * ".env.local" loaded nothing from here.
 *
 * In this monorepo the env file is at the repo root. In an app scaffolded by
 * `packages/cli` it sits next to this config, because the scaffold flattens the
 * app to a standalone project. dotenv keeps the FIRST value it sees for a key
 * and does not override an already-set variable, so listing both is safe in
 * either layout and wrong in neither.
 */
config({
  path: [
    // biome-ignore lint/correctness/noGlobalDirnameFilename: playwright transpiles this config to CJS via pirates, so `import.meta.dirname` — the rule's suggested fix — makes its loader treat the file as ESM and throw "exports is not defined in ES module scope" before any test runs. `__dirname` is what this loader actually provides.
    path.resolve(__dirname, ".env.local"),
    // biome-ignore lint/correctness/noGlobalDirnameFilename: same as above.
    path.resolve(__dirname, "../../.env.local"),
  ],
});

/**
 * Default 3100, matching `scripts/dev-local.sh`. Port 3000 is routinely taken
 * by an unrelated project on this machine, and pointing the suite at it means
 * asserting against somebody else's app rather than failing.
 */
const PORT = process.env.PORT || 3100;

/**
 * Set webServer.url and use.baseURL with the location
 * of the WebServer respecting the correct set port
 */
const baseURL = `http://localhost:${PORT}`;

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./tests",
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 1,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: "html",
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",
  },

  /* Configure global timeout for each test */
  timeout: 60 * 1000, // 60 seconds
  expect: {
    timeout: 60 * 1000,
  },

  /* Configure projects */
  projects: [
    {
      name: "chat",
      testMatch: /chat.e2e.ts/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "reasoning",
      testMatch: /reasoning.e2e.ts/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "artifacts",
      testMatch: /artifacts.e2e.ts/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },

    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    // `bun dev` starts Next on its own default port and does not load the
    // repo-root env file; `dev:local` is the command that does both.
    command: "bun run dev:local",
    url: baseURL,
    timeout: 120 * 1000,
    reuseExistingServer: !process.env.CI,
  },
});
