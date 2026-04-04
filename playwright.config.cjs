/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: './test',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 }
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    }
  ]
};
