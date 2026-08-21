const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: 'playwright-qa.spec.js',
  timeout: 120000,
  retries: 2,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: '../qa-results/playwright-qa-playwright-report.json' }]],
  use: {
    baseURL: 'https://bradleymatera.github.io',
    ...devices['Desktop Chrome'],
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
