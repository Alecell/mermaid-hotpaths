import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYGROUND_TEST_PORT ?? 9010);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Regression suite for the playground editor (`playground/`). Nothing here tests mermaid
 * itself — only this repo's own editor: the things that are easy to break by accident and
 * tedious to re-check by hand (creating elements, subgraph placement, note references,
 * selection overlays, the code panel's alignment with its highlighted backdrop).
 *
 * Runs against `playground/tests/static-server.ts`, which serves the built bundles and the
 * playground with no projects API — so the app uses `localStorage` and each test seeds its
 * own diagram, never touching real project data.
 */
export default defineConfig({
  testDir: './playground/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } },
    },
  ],
  webServer: {
    command: 'tsx playground/tests/static-server.ts',
    url: `${BASE_URL}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
