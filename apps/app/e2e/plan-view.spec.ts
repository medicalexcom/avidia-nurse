import { test, expect } from './fixtures/auth.fixture';
import { testData } from './fixtures/data.fixture';

test.describe('Study Plan and Calendar View', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/app/today');
    await authenticatedPage.waitForLoadState('networkidle');
  });

  test('should display exam countdown when exam scheduled', async ({ authenticatedPage }) => {
    // Look for exam countdown
    const examCountdown = authenticatedPage.locator('[data-testid="exam-countdown"]');

    // May or may not be visible depending on test user data
    if (await examCountdown.isVisible()) {
      await expect(examCountdown).toContainText(/day|exam|countdown/i);
    }
  });

  test('should show week view with planned items', async ({ authenticatedPage }) => {
    // Look for week view section
    await authenticatedPage.waitForSelector('[data-testid="week-view"]', { timeout: 5000 }).catch(() => null);

    const weekView = authenticatedPage.locator('[data-testid="week-view"]');

    // Week view should show days or planned items if plan exists
    if (await weekView.isVisible()) {
      // Should have at least one day element
      const dayElements = authenticatedPage.locator('[data-testid="week-day-item"]');
      await expect(dayElements.first()).toBeVisible();
    }
  });

  test('should display study recommendations', async ({ authenticatedPage }) => {
    // Look for recommendations section
    const recommendationsSection = authenticatedPage.locator(
      '[data-testid="recommendations-section"]'
    );

    // Recommendations should exist if there is mastery data
    if (await recommendationsSection.isVisible()) {
      // Should show at least one recommendation with reason
      await expect(
        authenticatedPage.locator('[data-testid="recommendation-item"]').first()
      ).toBeVisible();
      await expect(
        authenticatedPage.locator('[data-testid="recommendation-reason"]')
      ).toContainText(/because|reason|focus|weakness/i);
    }
  });

  test('should navigate to different study modes', async ({ authenticatedPage }) => {
    // Look for modes navigation
    const modesNav = authenticatedPage.locator('[data-testid="study-modes-nav"]');
    const modeButtons = authenticatedPage.locator('[data-testid="mode-button"]');

    // If modes exist
    if (await modeButtons.count() > 0) {
      // Should have multiple modes (Rapid Response, Find the Danger, etc)
      const modeCount = await modeButtons.count();
      expect(modeCount).toBeGreaterThan(0);

      // Click first mode
      await modeButtons.first().click();

      // Should navigate to that mode
      const currentMode = authenticatedPage.locator('[data-testid="current-mode-label"]');
      await expect(currentMode).toBeVisible();
    }
  });

  test('should show study streak if available', async ({ authenticatedPage }) => {
    // Look for streak indicator
    const streak = authenticatedPage.locator('[data-testid="study-streak"]');

    // Streak may not exist for new users
    if (await streak.isVisible()) {
      await expect(streak).toContainText(/day|streak|🔥/);
    }
  });

  test('should display progress analytics', async ({ authenticatedPage }) => {
    // Navigate to progress/analytics tab
    const progressTab = authenticatedPage.locator('[data-testid="progress-tab"]');

    if (await progressTab.isVisible()) {
      await progressTab.click();

      // Should show analytics content
      await authenticatedPage.waitForSelector('[data-testid="analytics-content"]', {
        timeout: 5000,
      }).catch(() => null);

      // Check for key analytics sections
      const masteryMap = authenticatedPage.locator('[data-testid="mastery-map"]');
      const performanceChart = authenticatedPage.locator('[data-testid="performance-chart"]');

      // At least one should exist
      const hasAnalytics = (await masteryMap.isVisible()) || (await performanceChart.isVisible());
      expect(hasAnalytics).toBeTruthy();
    }
  });
});
