import type { Ionicons } from '@expo/vector-icons';

import { SIDEBAR_MIN_WIDTH, type SectionKey } from './theme';

export type NavLayout = 'tabs' | 'sidebar';

/**
 * Responsive navigation decision for the authenticated shell:
 * phone-width screens get bottom tabs, tablets/desktop get a sidebar.
 * Kept as a pure function so it is unit-testable.
 */
export function pickNavLayout(windowWidth: number): NavLayout {
  return windowWidth >= SIDEBAR_MIN_WIDTH ? 'sidebar' : 'tabs';
}

type IconName = keyof typeof Ionicons.glyphMap;

export interface NavDestination {
  /** expo-router href inside the (app) group. */
  href: '/home' | '/courses' | '/study' | '/weaknesses' | '/progress' | '/profile';
  label: string;
  /** Which section-accent color (see theme.ts) this destination owns. */
  section: SectionKey;
  /** Outline icon, shown when this destination is not the active one. */
  icon: IconName;
  /** Filled icon, shown when this destination is active. */
  iconActive: IconName;
  /** True when the destination is a placeholder for a future milestone. */
  placeholder: boolean;
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  {
    href: '/home',
    label: 'Home',
    section: 'home',
    icon: 'home-outline',
    iconActive: 'home',
    placeholder: false,
  },
  {
    href: '/courses',
    label: 'Courses',
    section: 'courses',
    icon: 'book-outline',
    iconActive: 'book',
    placeholder: false,
  },
  {
    href: '/study',
    label: 'Study',
    section: 'study',
    icon: 'create-outline',
    iconActive: 'create',
    placeholder: false,
  },
  {
    href: '/weaknesses',
    label: 'Weaknesses',
    section: 'weaknesses',
    icon: 'flag-outline',
    iconActive: 'flag',
    placeholder: false,
  },
  {
    href: '/progress',
    label: 'Progress',
    section: 'progress',
    icon: 'trending-up-outline',
    iconActive: 'trending-up',
    placeholder: false,
  },
  {
    href: '/profile',
    label: 'Profile',
    section: 'profile',
    icon: 'person-circle-outline',
    iconActive: 'person-circle',
    placeholder: false,
  },
] as const;
