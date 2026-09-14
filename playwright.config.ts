import { defineConfig } from '@playwright/test';

// One browser per test: each test launches its own persistent context with the extension loaded.
export default defineConfig({
  testDir: './test/e2e',
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
});
