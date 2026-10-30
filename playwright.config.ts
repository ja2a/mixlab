import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: '.dev/e2e-results',
});
