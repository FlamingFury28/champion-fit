import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.CHAMPION_FIT_E2E_PORT ?? 18787)
const baseURL = process.env.CHAMPION_FIT_E2E_BASE_URL ?? `http://127.0.0.1:${port}`
const externalServer = process.env.CHAMPION_FIT_E2E_EXTERNAL_SERVER === '1'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  snapshotPathTemplate: '{testDir}/visual-baselines/{platform}/{arg}{ext}',
  timeout: 30_000,
  expect: {
    timeout: 7_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.015 },
  },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: externalServer ? undefined : {
    command: 'python e2e/seed_and_serve.py',
    url: `${baseURL}/api/sync-status`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'firefox-smoke', grep: /@smoke/, use: { ...devices['Desktop Firefox'], viewport: { width: 1024, height: 768 } } },
    { name: 'webkit-smoke', grep: /@smoke/, use: { ...devices['Desktop Safari'], viewport: { width: 390, height: 844 } } },
  ],
})
