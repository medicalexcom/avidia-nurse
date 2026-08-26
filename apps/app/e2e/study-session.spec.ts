import { test, expect } from './fixtures/auth.fixture';
import { testData, testScenarios } from './fixtures/data.fixture';

test.describe('Daily Study Flow', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    // Start from today's view
    await authenticatedPage.goto('/app/today');
    await authenticatedPage.waitForLoadState('networkidle');
  });

  test('should display START TODAY button with study plan', async ({ authenticatedPage }) => {
    // Should see the main study action
    const startTodayButton = authenticatedPage.locator('[data-testid="start-today-button"]');
    await expect(startTodayButton).toBeVisible();
    await expect(startTodayButton).toContainText(/start.*today/i);

    // Should show study time options or current plan
    await expect(authenticatedPage.locator('[data-testid="study-time-indicator"]')).toBeVisible();
  });

  test('should select study time and start adaptive session', async ({ authenticatedPage }) => {
    // Click START TODAY
    await authenticatedPage.click('[data-testid="start-today-button"]');

    // Should show time selection dialog
    await authenticatedPage.waitForSelector('[data-testid="time-selection-modal"]');

    // Select standard 20-minute session
    await authenticatedPage.click('[data-testid="time-option-20-minutes"]');

    // Should transition to study session
    await expect(authenticatedPage).toHaveURL(/\/study|session/);
    await authenticatedPage.waitForSelector('[data-testid="question-card"]');

    // First question should be visible
    await expect(authenticatedPage.locator('[data-testid="question-text"]')).toBeVisible();
    await expect(authenticatedPage.locator('[data-testid="answer-options"]')).toBeVisible();
  });

  test('should answer questions in adaptive session', async ({ authenticatedPage }) => {
    // Start session
    await authenticatedPage.click('[data-testid="start-today-button"]');
    await authenticatedPage.click('[data-testid="time-option-20-minutes"]');
    await authenticatedPage.waitForSelector('[data-testid="question-card"]');

    // Answer multiple questions
    for (let i = 0; i < 3; i++) {
      // Wait for question to load
      await authenticatedPage.waitForSelector('[data-testid="answer-options"]');

      // Select first answer option
      await authenticatedPage.click('[data-testid="answer-option-0"]');

      // Optionally add confidence rating
      await authenticatedPage
        .click('[data-testid="confidence-button"]', { timeout: 1000 })
        .catch(() => null);

      // Wait for next question or completion
      await authenticatedPage.waitForTimeout(500);
    }
  });

  test('should show confidence rating option', async ({ authenticatedPage }) => {
    // Start session
    await authenticatedPage.click('[data-testid="start-today-button"]');
    await authenticatedPage.click('[data-testid="time-option-20-minutes"]');
    await authenticatedPage.waitForSelector('[data-testid="question-card"]');

    // Answer a question
    await authenticatedPage.click('[data-testid="answer-option-0"]');

    // Confidence button should appear
    const confidenceButton = authenticatedPage.locator('[data-testid="confidence-button"]');
    await expect(confidenceButton).toBeVisible({ timeout: 2000 });

    // Click confidence option
    await confidenceButton.click();

    // Should show confidence toggle/rating
    await expect(authenticatedPage.locator('[data-testid="confidence-rating"]')).toBeVisible();
  });

  test('should complete session and show summary', async ({ authenticatedPage }) => {
    // Start and complete session
    await authenticatedPage.click('[data-testid="start-today-button"]');
    await authenticatedPage.click('[data-testid="time-option-20-minutes"]');

    let questionCount = 0;
    const maxQuestions = 10;

    // Answer questions until session ends or max reached
    while (questionCount < maxQuestions) {
      try {
        await authenticatedPage.waitForSelector('[data-testid="question-card"]', {
          timeout: 2000,
        });
        await authenticatedPage.click('[data-testid="answer-option-0"]');
        questionCount++;
      } catch (e) {
        // Session likely ended
        break;
      }
    }

    // Should show session summary
    await authenticatedPage.waitForSelector('[data-testid="session-summary"]');

    // Summary should show counts, concepts, and mastery changes
    await expect(authenticatedPage.locator('[data-testid="questions-answered"]')).toBeVisible();
    await expect(authenticatedPage.locator('[data-testid="concepts-studied"]')).toBeVisible();

    // Should have "Return to Today" or similar button
    const returnButton = authenticatedPage.locator('[data-testid="return-to-today-button"]');
    await expect(returnButton).toBeVisible();
  });

  test('should handle skip behavior correctly', async ({ authenticatedPage }) => {
    // Start session
    await authenticatedPage.click('[data-testid="start-today-button"]');
    await authenticatedPage.click('[data-testid="time-option-20-minutes"]');
    await authenticatedPage.waitForSelector('[data-testid="question-card"]');

    // Skip a question
    const skipButton = authenticatedPage.locator('[data-testid="skip-button"]');
    await expect(skipButton).toBeVisible();
    await skipButton.click();

    // Next question should load
    await authenticatedPage.waitForTimeout(500);
    await expect(authenticatedPage.locator('[data-testid="question-text"]')).toBeVisible();

    // Skipped question should not be scored
  });
});
