/** Minimal design tokens for M1. A full design system arrives with packages/ui. */
export const colors = {
  primary: '#0f6bff',
  primaryDark: '#0a4fc0',
  background: '#f7f9fc',
  surface: '#ffffff',
  border: '#e2e8f0',
  text: '#0f172a',
  textMuted: '#64748b',
  danger: '#dc2626',
  badge: '#eef2ff',
  badgeText: '#4338ca',
} as const;

export const spacing = (n: number) => n * 4;

/** Breakpoint above which the shell switches from tab bar to sidebar. */
export const SIDEBAR_MIN_WIDTH = 768;
