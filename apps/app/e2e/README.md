# Avidia Nurse E2E Tests (Playwright)

End-to-end testing suite for critical student learning flows.

## Overview

These tests verify the core student journey across all platforms (iOS, Android, web):

- **Authentication**: Sign-up, sign-in, password reset, session persistence
- **Daily Study Flow**: START TODAY, time selection, adaptive questioning, completion
- **Study Planning**: Exam countdowns, week view, recommendations, study modes
- **Course Enrollment**: Browse courses, enroll, view materials and modules
- **Mastery Engine**: Mastery updates after study, misconception detection, spaced repetition

## Quick Start

### Prerequisites

- Node.js 20+ (22 recommended)
- pnpm 10
- Running web app: `pnpm web`
- (Optional) Supabase with test data configured in `.env`

### Install Dependencies

```bash
pnpm install
```

### Run Tests

```bash
# Run all tests
pnpm test:e2e

# Run with UI (headed mode, great for debugging)
pnpm test:e2e:ui

# Run in debug mode (interactive debugger)
pnpm test:e2e:debug

# Run in headed mode (watch browser)
pnpm test:e2e:headed

# Run specific test file
pnpm test:e2e -- e2e/auth.spec.ts

# Run specific test
pnpm test:e2e -- e2e/auth.spec.ts -g "should sign up"
```

## Test Files

### `auth.spec.ts`

Authentication and session management:

- Sign-up with email/password
- Sign-in
- Invalid credentials error handling
- Password reset flow
- Session persistence on reload

### `study-session.spec.ts`

Daily adaptive study experience:

- START TODAY button visibility
- Study time selection (5/10/20/45 minutes)
- Adaptive question flow
- Confidence rating integration
- Session completion and summary
- Skip behavior

### `plan-view.spec.ts`

Study planning and recommendations:

- Exam countdown display
- Week view with planned items
- Study recommendations with reasons
- Study modes navigation
- Study streak tracking
- Progress analytics tabs

### `course-enrollment.spec.ts`

Course and material navigation:

- Display available courses
- Course enrollment flow
- Course detail and modules
- Concepts/learning objectives
- Material loading without errors

### `mastery-update.spec.ts`

Mastery engine and learning evidence:

- Mastery state updates after study
- Misconception detection
- Spaced repetition interval tracking

## Fixtures

### `auth.fixture.ts`

Provides `authenticatedPage` fixture with auto-login.

```typescript
test('my test', async ({ authenticatedPage }) => {
  // User is already signed in
  await authenticatedPage.goto('/app/today');
});
```

### `data.fixture.ts`

Realistic test data and scenarios:

- Courses (NCLEX-RN, Fundamentals)
- Nursing concepts
- Study plan configurations
- Exam scenarios

## CI/CD Integration

Tests run on every push and pull request via `.github/workflows/e2e-tests.yml`

## Best Practices

### Test Selectors

All selectors use `data-testid` attributes:

```typescript
await page.locator('[data-testid="start-today-button"]').click();
```

**App developers**: Add `data-testid` to critical UI elements:

```tsx
<Button data-testid="start-today-button" onPress={startStudy}>
  START TODAY
</Button>
```

### Waiting Strategies

```typescript
// Wait for element to be visible
await expect(page.locator('[data-testid="modal"]')).toBeVisible();

// Wait for navigation
await expect(page).toHaveURL(/\/app\/today/);

// Wait for network to settle
await page.waitForLoadState('networkidle');

// Wait for timeout (last resort)
await page.waitForTimeout(1000);
```

### Handling Flakes

- Use `.isVisible({ timeout: 2000 }).catch(() => false)` for optional elements
- Use `page.waitForLoadState('networkidle')` before assertions
- Retry logic configured in `playwright.config.ts` (2 retries on CI)

## Debugging

### View Test Report

```bash
pnpm exec playwright show-report
```

### Screenshots & Videos

On failure, screenshots and videos are retained in `test-results/`.

### Debug Mode

```bash
pnpm test:e2e:debug -- e2e/auth.spec.ts
```

Opens Playwright Inspector for step-by-step execution.

### Trace Viewer

Traces are recorded on first retry; open with:

```bash
pnpm exec playwright show-trace test-results/trace.zip
```

## Environment Variables

| Variable            | Default                 | Purpose                      |
| ------------------- | ----------------------- | ---------------------------- |
| `TEST_BASE_URL`     | `http://localhost:8081` | App URL for tests            |
| `SUPABASE_URL`      | (from `.env`)           | Database for auth/data       |
| `SUPABASE_ANON_KEY` | (from `.env`)           | Supabase client key          |
| `CI`                | (GitHub Actions)        | Enables CI-specific behavior |

## Common Issues

### "Port 8081 is already in use"

```bash
# Kill existing process
lsof -ti:8081 | xargs kill -9
```

### Tests timeout on auth

- Verify `.env` has `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- Check Supabase project is online and accessible
- Verify test user can sign up (email confirmation may be required)

### Flaky auth tests

- Supabase auth may rate-limit; add delay between sign-ups
- Use unique email addresses: `test-${Date.now()}@avidia.test`
- Check for existing test users in Supabase Auth console

## Next Steps

1. **Add `data-testid` to app components** — Test suite won't work without selectors
2. **Configure test Supabase project** — Create free tier project and link in CI
3. **Run tests on first PR** — Will reveal which selectors/flows need attention
4. **Integrate into CI workflow** — CI is ready; just ensure test credentials are configured
5. **Expand coverage** — Add tests for billing, simulations, advanced modes
