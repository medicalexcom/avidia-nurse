import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';

import UpgradeScreen from '../../../app/(app)/upgrade';
import { AppErrorBoundary } from '../../components/AppErrorBoundary';
import { bufferedEvents, resetAnalytics } from '../../lib/analytics';

/**
 * Paywall + error-boundary UI tests — M14 (spec M/N/AG/AV).
 * getSupabase() is unconfigured under Jest, so the screen exercises its
 * no-client path; what we pin here is the RESTRAINED paywall contract:
 * renewal/cancellation/data-retention facts are on screen, the funnel event
 * fires, and the free plan's kept features are stated.
 */

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

describe('paywall (spec M/N)', () => {
  beforeEach(() => resetAnalytics());

  it('states renewal, cancellation and data retention before any payment', async () => {
    render(<UpgradeScreen />);
    await waitFor(() => {
      expect(screen.getByText(/renews automatically until you cancel/i)).toBeTruthy();
    });
    expect(screen.getByText(/Cancel anytime/i)).toBeTruthy();
    expect(screen.getByText(/all of your learning data stays/i)).toBeTruthy();
    // The price is shown at Stripe checkout — the paywall says so instead of
    // hardcoding an unapproved number (Blueprint prices are hypotheses).
    expect(screen.getByText(/shown before you pay/i)).toBeTruthy();
  });

  it('keeps the free plan honest: core study is listed as never paywalled', async () => {
    render(<UpgradeScreen />);
    await waitFor(() => {
      expect(screen.getByText(/Adaptive daily study/i)).toBeTruthy();
    });
    expect(screen.getByText(/nothing is ever deleted/i)).toBeTruthy();
  });

  it('emits exactly the payload-free paywall_viewed funnel event (spec AG)', async () => {
    render(<UpgradeScreen />);
    await waitFor(() => {
      expect(bufferedEvents().some((e) => e.name === 'paywall_viewed')).toBe(true);
    });
    const event = bufferedEvents().find((e) => e.name === 'paywall_viewed');
    expect(Object.keys(event as object)).toEqual(['name']);
  });
});

describe('root error boundary (spec AV)', () => {
  it('renders a recoverable screen instead of crashing', async () => {
    const Boom = () => {
      throw new Error('render exploded');
    };
    // Silence React's expected error logging for this intentional crash.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>
    );
    expect(screen.getByTestId('app-error-boundary')).toBeTruthy();
    expect(screen.getByText(/Your study data is safe/i)).toBeTruthy();
    spy.mockRestore();
  });

  it('renders children untouched when nothing throws', async () => {
    await render(
      <AppErrorBoundary>
        <Text>healthy subtree</Text>
      </AppErrorBoundary>
    );
    expect(screen.getByText('healthy subtree')).toBeTruthy();
    expect(screen.queryByTestId('app-error-boundary')).toBeNull();
  });
});
