import { test, expect } from './fixtures/auth.fixture';

test.describe('Authentication Flow', () => {
  test('should sign up a new user', async ({ page, testEmail, testPassword }) => {
    await page.goto('/');

    // Wait for auth container
    await page.waitForSelector('[data-testid="auth-container"]');

    // Click sign-up link
    await page.click('[data-testid="sign-up-link"]');

    // Fill form
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.fill('[data-testid="password-input"]', testPassword);
    await page.fill('[data-testid="confirm-password-input"]', testPassword);

    // Submit
    await page.click('[data-testid="submit-button"]');

    // Should redirect to app
    await expect(page).toHaveURL(/\/(app|today)/);

    // User profile should be visible
    await expect(page.locator('[data-testid="user-profile"]')).toBeVisible();
  });

  test('should sign in an existing user', async ({ page, testEmail, testPassword }) => {
    await page.goto('/');

    // Wait for auth container
    await page.waitForSelector('[data-testid="auth-container"]');

    // Fill login form
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.fill('[data-testid="password-input"]', testPassword);

    // Submit
    await page.click('[data-testid="submit-button"]');

    // Should redirect to app
    await expect(page).toHaveURL(/\/(app|today)/);
  });

  test('should show error on invalid credentials', async ({ page }) => {
    await page.goto('/');

    await page.waitForSelector('[data-testid="auth-container"]');

    await page.fill('[data-testid="email-input"]', 'invalid@test.com');
    await page.fill('[data-testid="password-input"]', 'wrongpassword');

    await page.click('[data-testid="submit-button"]');

    // Should show error message
    await expect(page.locator('[data-testid="error-message"]')).toContainText(
      /invalid|incorrect|failed/i
    );
  });

  test('should handle password reset', async ({ page, testEmail }) => {
    await page.goto('/');

    await page.waitForSelector('[data-testid="auth-container"]');

    // Click forgot password
    await page.click('[data-testid="forgot-password-link"]');

    // Fill email
    await page.fill('[data-testid="reset-email-input"]', testEmail);

    // Submit
    await page.click('[data-testid="send-reset-link-button"]');

    // Should show success message
    await expect(page.locator('[data-testid="success-message"]')).toContainText(
      /check.*email|password.*reset/i
    );
  });

  test('should persist session on page reload', async ({ authenticatedPage }) => {
    // User is already authenticated via fixture
    await authenticatedPage.goto('/');

    // Should be in app, not redirected to login
    await expect(authenticatedPage).toHaveURL(/\/(app|today)/);

    // Reload page
    await authenticatedPage.reload();

    // Should still be logged in
    await expect(authenticatedPage).toHaveURL(/\/(app|today)/);
    await expect(authenticatedPage.locator('[data-testid="user-profile"]')).toBeVisible();
  });
});
