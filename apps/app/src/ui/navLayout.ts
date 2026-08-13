import { SIDEBAR_MIN_WIDTH } from './theme';

export type NavLayout = 'tabs' | 'sidebar';

/**
 * Responsive navigation decision for the authenticated shell:
 * phone-width screens get bottom tabs, tablets/desktop get a sidebar.
 * Kept as a pure function so it is unit-testable.
 */
export function pickNavLayout(windowWidth: number): NavLayout {
  return windowWidth >= SIDEBAR_MIN_WIDTH ? 'sidebar' : 'tabs';
}

export interface NavDestination {
  /** expo-router href inside the (app) group. */
  href: '/home' | '/courses' | '/study' | '/weaknesses' | '/progress' | '/profile';
  label: string;
  /** Simple glyph so M1 needs no icon library. */
  glyph: string;
  /** True when the destination is a placeholder for a future milestone. */
  placeholder: boolean;
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  { href: '/home', label: 'Home', glyph: '⌂', placeholder: false },
  { href: '/courses', label: 'Courses', glyph: '▤', placeholder: true },
  { href: '/study', label: 'Study', glyph: '✎', placeholder: true },
  { href: '/weaknesses', label: 'Weaknesses', glyph: '◎', placeholder: true },
  { href: '/progress', label: 'Progress', glyph: '↗', placeholder: true },
  { href: '/profile', label: 'Profile', glyph: '●', placeholder: false },
] as const;
