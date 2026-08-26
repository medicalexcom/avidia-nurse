import { test as base, Page } from '@playwright/test';

type AuthFixtures = {
  authenticatedPage: Page;
  testEmail: string;
  testPassword: string;
};

const TEST_EMAIL = `test-${Date.now()}@avidia.test`;
const TEST_PASSWORD = 'TestPassword123!';

export const test = base.extend<AuthFixtures>({
  testEmail: TEST_EMAIL,
  testPassword: TEST_PASSWORD,

  authenticatedPage: async ({ page }, use) => {
    // Navigate to login
    await page.goto('/');
    
    // Wait for auth screen to be ready
    await page.waitForSelector('[data-testid="auth-container"]', { timeout: 5000 });
    
    // Try to find existing session token in localStorage
    const existingToken = await page.evaluate(() => {
      return localStorage.getItem('sb-auth-token') || null;
    });

    if (!existingToken) {
      // Sign up new user
      await page.click('[data-testid="sign-up-link"]');
      await page.fill('[data-testid="email-input"]', TEST_EMAIL);
      await page.fill('[data-testid="password-input"]', TEST_PASSWORD);
      await page.click('[data-testid="submit-button"]');
      
      // Wait for redirect to app after sign-up
      await page.waitForNavigation({ url: /\/(app|today)/ });
    }
    
    await use(page);
  },
});

export { expect } from '@playwright/test';
