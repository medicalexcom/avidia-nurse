import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NAV_DESTINATIONS, pickNavLayout } from './navLayout';
import { colors, spacing } from './theme';

/**
 * Authenticated application shell.
 *
 * One component, one set of destinations, two responsive presentations:
 * - narrow (phone): bottom tab bar
 * - wide (tablet/desktop): left sidebar
 * Business logic never forks between mobile and web.
 */
export function ResponsiveShell({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions();
  const layout = pickNavLayout(width);
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const items = NAV_DESTINATIONS.map((dest) => {
    const active = pathname === dest.href;
    return (
      <Pressable
        key={dest.href}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        onPress={() => router.replace(dest.href)}
        style={[
          layout === 'sidebar' ? styles.sidebarItem : styles.tabItem,
          active && (layout === 'sidebar' ? styles.sidebarItemActive : styles.tabItemActive),
        ]}
      >
        <Text style={[styles.glyph, active && styles.glyphActive]}>{dest.glyph}</Text>
        <Text
          style={[
            layout === 'sidebar' ? styles.sidebarLabel : styles.tabLabel,
            active && styles.labelActive,
          ]}
        >
          {dest.label}
        </Text>
      </Pressable>
    );
  });

  if (layout === 'sidebar') {
    return (
      <View style={styles.rowRoot}>
        <View style={[styles.sidebar, { paddingTop: insets.top + spacing(6) }]}>
          <Text style={styles.brand}>Avidia Nurse</Text>
          {items}
        </View>
        <View style={styles.content}>{children}</View>
      </View>
    );
  }

  return (
    <View style={styles.columnRoot}>
      <View style={styles.content}>{children}</View>
      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, spacing(2)) }]}>
        {items}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rowRoot: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },
  columnRoot: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1 },
  brand: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    paddingHorizontal: spacing(4),
    marginBottom: spacing(4),
  },
  sidebar: {
    width: 220,
    backgroundColor: colors.surface,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
    paddingHorizontal: spacing(2),
    gap: spacing(1),
  },
  sidebarItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    paddingVertical: spacing(2.5),
    paddingHorizontal: spacing(3),
    borderRadius: 8,
  },
  sidebarItemActive: { backgroundColor: colors.badge },
  sidebarLabel: { fontSize: 15, color: colors.textMuted },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing(1.5),
  },
  tabItem: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: spacing(1) },
  tabItemActive: {},
  tabLabel: { fontSize: 11, color: colors.textMuted },
  glyph: { fontSize: 18, color: colors.textMuted },
  glyphActive: { color: colors.primary },
  labelActive: { color: colors.primary, fontWeight: '600' },
});
