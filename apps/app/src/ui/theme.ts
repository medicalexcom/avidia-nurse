import type { ViewStyle } from 'react-native';

/**
 * Design tokens.
 *
 * Started life as "Minimal design tokens for M1" — a placeholder comment
 * that survived unchanged through M15. This is the first real pass: a
 * proper neutral palette, a per-section accent system (so Home/Courses/
 * Study/Weaknesses/Progress/Profile read as distinct places instead of the
 * same list template with a different header), a small type scale, radii,
 * and shadow tokens.
 *
 * Deliberately still light-mode-only and still lives in `apps/app/src/ui`
 * rather than a standalone `packages/ui` workspace package — promoting it
 * once the shape has proven out across a few more screens is a good,
 * mechanical follow-up, not bundled into this pass.
 */

export const colors = {
  primary: '#0f6bff',
  primaryDark: '#0a4fc0',
  background: '#f7f9fc',
  surface: '#ffffff',
  surfaceSunken: '#eef2f7',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  text: '#0f172a',
  textMuted: '#64748b',
  textFaint: '#94a3b8',
  danger: '#dc2626',
  dangerSoft: '#fef2f2',
  good: '#15803d',
  goodSoft: '#e7f5ec',
  badge: '#eef2ff',
  badgeText: '#4338ca',
} as const;

/**
 * One accent per primary navigation destination. Used for that section's
 * nav icon, its screen-header icon chip, and list rows that belong to it —
 * the cheapest way to make six screens sharing one layout language still
 * feel like six distinct places.
 */
export const sectionAccents = {
  home: { accent: '#0f6bff', soft: '#e6f0ff' },
  courses: { accent: '#7c3aed', soft: '#f1ebfe' },
  study: { accent: '#0e7490', soft: '#e3f4f7' },
  weaknesses: { accent: '#c2410c', soft: '#fdece1' },
  progress: { accent: '#15803d', soft: '#e7f5ec' },
  profile: { accent: '#475569', soft: '#eef1f4' },
} as const;

export type SectionKey = keyof typeof sectionAccents;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

/**
 * Small type scale for new components. Not a repo-wide migration — most
 * existing screens still set literal fontSize/fontWeight in their own
 * StyleSheet, which is fine; this exists so new shared components stop
 * inventing their own numbers.
 */
export const type = {
  display: { fontSize: 26, fontWeight: '700' as const, lineHeight: 32 },
  title: { fontSize: 20, fontWeight: '700' as const, lineHeight: 26 },
  heading: { fontSize: 16, fontWeight: '600' as const, lineHeight: 22 },
  body: { fontSize: 15, fontWeight: '400' as const, lineHeight: 21 },
  label: { fontSize: 13, fontWeight: '600' as const, lineHeight: 18 },
  caption: { fontSize: 12, fontWeight: '500' as const, lineHeight: 16 },
};

/**
 * Cross-platform elevation. `elevation` covers Android; the shadow* props
 * cover iOS and are translated to a CSS box-shadow by react-native-web on
 * web — one definition, three targets.
 */
export const shadow: Record<'sm' | 'md', ViewStyle> = {
  sm: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  md: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
  },
};

export const spacing = (n: number) => n * 4;

/** Breakpoint above which the shell switches from tab bar to sidebar. */
export const SIDEBAR_MIN_WIDTH = 768;
