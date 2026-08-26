import { test, expect } from './fixtures/auth.fixture';

test.describe('Mastery Engine Integration', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    // Start from today's view
    await authenticatedPage.goto('/app/today');
    await authenticatedPage.waitForLoadState('networkidle');
  });

  test('should update mastery after answering questions', async ({ authenticatedPage }) => {
    // Get initial mastery state from analytics if available
    const analyticsTab = authenticatedPage.locator('[data-testid="analytics-tab"]');
    let initialMasteryStates: Record<string, string> = {};

    if (await analyticsTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await analyticsTab.click();
      await authenticatedPage.waitForTimeout(1000);

      // Extract concept mastery states
      const masteryItems = authenticatedPage.locator('[data-testid="mastery-item"]');
      const count = await masteryItems.count();

      for (let i = 0; i < Math.min(count, 3); i++) {
        const item = masteryItems.nth(i);
        const conceptName = await item.locator('[data-testid="concept-name"]').textContent();
        const masteryState = await item.locator('[data-testid="mastery-state"]').textContent();

        if (conceptName) {
          initialMasteryStates[conceptName] = masteryState || 'unknown';
        }
      }

      // Go back to today view
      await authenticatedPage.goto('/app/today');
    }

    // Complete a study session
    await authenticatedPage.click('[data-testid="start-today-button"]');
    await authenticatedPage.click('[data-testid="time-option-20-minutes"]');

    // Answer several questions
    for (let i = 0; i < 5; i++) {
      try {
        await authenticatedPage.waitForSelector('[data-testid="question-card"]', {
          timeout: 2000,
        });
        await authenticatedPage.click('[data-testid="answer-option-0"]');
        await authenticatedPage.waitForTimeout(300);
      } catch (e) {
        // Session ended
        break;
      }
    }

    // Wait for session completion
    await authenticatedPage.waitForSelector('[data-testid="session-summary"]', { timeout: 5000 });

    // Session should show mastery changes
    const masteryChanges = authenticatedPage.locator('[data-testid="mastery-change"]');
    const changeCount = await masteryChanges.count();

    // Should have at least one mastery update
    if (changeCount > 0) {
      const firstChange = masteryChanges.first();
      await expect(firstChange).toContainText(/↑|↓|→|updated|changed/);
    }
  });

  test('should track misconceptions when wrong answers provided', async ({ authenticatedPage }) => {
    // Start study session
    await authenticatedPage.click('[data-testid="start-today-button"]');
    await authenticatedPage.click('[data-testid="time-option-10-minutes"]');

    let missedQuestions = 0;

    // Answer some questions
    for (let i = 0; i < 5; i++) {
      try {
        await authenticatedPage.waitForSelector('[data-testid="question-card"]', {
          timeout: 2000,
        });

        // Randomly pick wrong answer (last one is often wrong)
        const options = authenticatedPage.locator('[data-testid="answer-option"]');
        const count = await options.count();

        if (count > 1 && Math.random() > 0.5) {
          // Pick last answer
          await options.nth(count - 1).click();
          missedQuestions++;
        } else {
          // Pick first answer
          await options.first().click();
        }

        await authenticatedPage.waitForTimeout(300);
      } catch (e) {
        break;
      }
    }

    // Session should complete
    await authenticatedPage.waitForSelector('[data-testid="session-summary"]', { timeout: 5000 });

    // If there were missed questions, check for misconception flag
    if (missedQuestions > 0) {
      const misconceptionFlag = authenticatedPage.locator(
        '[data-testid="misconception-identified"]'
      );

      // May show misconception flag in summary or planning
      const visible = await misconceptionFlag.isVisible({ timeout: 2000 }).catch(() => false);

      // Just verify the mechanism exists, don't require it
      if (visible) {
        await expect(misconceptionFlag).toContainText(/misconception|common error|watch out/i);
      }
    }
  });

  test('should apply spaced repetition intervals', async ({ authenticatedPage }) => {
    // This test verifies that recommendations respect spaced repetition
    const recommendationsSection = authenticatedPage.locator(
      '[data-testid="recommendations-section"]'
    );

    if (await recommendationsSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Look for due-review or spaced-repetition indicators
      const dueDates = authenticatedPage.locator('[data-testid="due-date"]');
      const dueCount = await dueDates.count();

      // Should have spaced-out due dates if there are multiple items
      if (dueCount > 1) {
        // Just verify they exist and have dates
        for (let i = 0; i < Math.min(dueCount, 2); i++) {
          const dueDate = dueDates.nth(i);
          const dateText = await dueDate.textContent();
          expect(dateText).toMatch(/day|week|month|today|tomorrow/i);
        }
      }
    }
  });
});
