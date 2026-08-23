// Minimal Playwright configuration for ProjectHub QA specs.
// The QA spec navigates to a relative path, so a baseURL is required.
module.exports = {
  testMatch: 'scripts/playwright-qa.spec.js',
  use: {
    baseURL: process.env.PROJECTHUB_ORIGIN || 'https://bradleymatera.github.io/ProjectHub-dev/',
    headless: true,
    viewport: { width: 1280, height: 720 }
  },
  reporter: [['line']]
};
