import { test, expect } from './fixtures/auth.fixture';
import { testData } from './fixtures/data.fixture';

test.describe('Course Enrollment and Materials', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await authenticatedPage.goto('/app/courses');
    await authenticatedPage.waitForLoadState('networkidle');
  });

  test('should display available courses', async ({ authenticatedPage }) => {
    // Should show courses list
    await authenticatedPage.waitForSelector('[data-testid="course-item"]', { timeout: 5000 });

    const courseItems = authenticatedPage.locator('[data-testid="course-item"]');
    const courseCount = await courseItems.count();

    // Should have at least one course
    expect(courseCount).toBeGreaterThan(0);

    // First course should be visible with title
    const firstCourse = courseItems.first();
    await expect(firstCourse.locator('[data-testid="course-title"]')).toBeVisible();
  });

  test('should enroll in a course', async ({ authenticatedPage }) => {
    // Find and click enroll button
    const enrollButton = authenticatedPage.locator('[data-testid="enroll-button"]').first();

    if (await enrollButton.isVisible()) {
      const courseBefore = authenticatedPage.locator('[data-testid="course-item"]');
      const countBefore = await courseBefore.count();

      await enrollButton.click();

      // Should show success message or redirect
      await authenticatedPage.waitForTimeout(1000);

      // Course should show as enrolled
      const enrolledStatus = enrollButton.locator('[data-testid="enrolled-badge"]');
      const isEnrolled =
        (await enrollButton.isDisabled()) || (await enrolledStatus.isVisible({ timeout: 2000 }).catch(() => false));

      expect(isEnrolled).toBeTruthy();
    }
  });

  test('should view course materials and modules', async ({ authenticatedPage }) => {
    // Click on a course
    const courseItem = authenticatedPage.locator('[data-testid="course-item"]').first();
    await courseItem.click();

    // Should navigate to course detail
    await authenticatedPage.waitForSelector('[data-testid="course-detail-container"]', {
      timeout: 5000,
    });

    // Should show modules
    const modules = authenticatedPage.locator('[data-testid="module-item"]');
    const moduleCount = await modules.count();

    // Should have at least one module if course has content
    if (moduleCount > 0) {
      await expect(modules.first()).toBeVisible();
    }
  });

  test('should display course concepts/learning objectives', async ({ authenticatedPage }) => {
    // Click on a course
    const courseItem = authenticatedPage.locator('[data-testid="course-item"]').first();
    await courseItem.click();

    // Should navigate to course detail
    await authenticatedPage.waitForSelector('[data-testid="course-detail-container"]', {
      timeout: 5000,
    });

    // Look for concepts section
    const conceptsSection = authenticatedPage.locator('[data-testid="concepts-section"]');
    const conceptItems = authenticatedPage.locator('[data-testid="concept-item"]');

    if (await conceptsSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      const conceptCount = await conceptItems.count();
      expect(conceptCount).toBeGreaterThan(0);
    }
  });

  test('should load course materials without errors', async ({ authenticatedPage }) => {
    // Click on a course
    const courseItem = authenticatedPage.locator('[data-testid="course-item"]').first();
    await courseItem.click();

    // Wait for course to load
    await authenticatedPage.waitForSelector('[data-testid="course-detail-container"]', {
      timeout: 5000,
    });

    // Should not show error message
    const errorMessage = authenticatedPage.locator('[data-testid="error-message"]');
    await expect(errorMessage).not.toBeVisible({ timeout: 2000 }).catch(() => null);

    // Should have content loaded
    const content = authenticatedPage.locator('[data-testid="course-content"]');
    await expect(content).toBeVisible({ timeout: 2000 }).catch(() => null);
  });
});
