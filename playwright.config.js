// Minimal Playwright configuration for ProjectHub QA specs.
// The QA spec navigates to a relative path, so a baseURL is required.
module.exports = {
  testDir: './scripts',
  testMatch: 'playwright-qa.spec.js',
  timeout: 90000,
  use: {
    baseURL: 'https://bradleymatera.github.io/ProjectHub-dev/',
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 30000,
  },
  reporter: [['line']],
};
