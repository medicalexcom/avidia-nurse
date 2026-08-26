import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { NAV_DESTINATIONS, pickNavLayout } from './navLayout';
import { colors, radius, sectionAccents, shadow, spacing } from './theme';

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
    const accent = sectionAccents[dest.section].accent;
    return (
      <Pressable
        key={dest.href}
        accessibilityRole="button"
        accessibilityLabel={dest.label}
        accessibilityState={{ selected: active }}
        onPress={() => router.replace(dest.href)}
        style={[
          layout === 'sidebar' ? styles.sidebarItem : styles.tabItem,
          active &&
            (layout === 'sidebar' ? { backgroundColor: sectionAccents[dest.section].soft } : null),
        ]}
      >
        <Ionicons
          name={active ? dest.iconActive : dest.icon}
          size={layout === 'sidebar' ? 20 : 22}
          color={active ? accent : colors.textMuted}
        />
        <Text
          style={[
            layout === 'sidebar' ? styles.sidebarLabel : styles.tabLabel,
            active && [styles.labelActive, { color: accent }],
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
          <View style={styles.brandLockup}>
            <View style={styles.brandMark}>
              <Ionicons name="pulse" size={19} color="#ffffff" />
            </View>
            <View>
              <Text style={styles.brand}>Avidia</Text>
              <Text style={styles.brandSub}>NURSE</Text>
            </View>
          </View>
          <Text style={styles.navLabel}>WORKSPACE</Text>
          {items}
          <View style={styles.sidebarFooter}>
            <Ionicons name="sparkles-outline" size={17} color={colors.primary} />
            <Text style={styles.sidebarFooterText}>Study with intention.</Text>
          </View>
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
  brandLockup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2.5),
    paddingHorizontal: spacing(3),
    marginBottom: spacing(7),
  },
  brandMark: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.sm,
  },
  brand: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.4,
  },
  brandSub: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.6,
    color: colors.primary,
    marginTop: -1,
  },
  navLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: colors.textFaint,
    paddingHorizontal: spacing(3),
    marginBottom: spacing(2),
  },
  sidebar: {
    width: 244,
    backgroundColor: '#fbfbfe',
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingHorizontal: spacing(2),
    gap: spacing(1),
  },
  sidebarItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
    paddingVertical: spacing(2.75),
    paddingHorizontal: spacing(3),
    borderRadius: radius.sm,
  },
  sidebarLabel: { fontSize: 14, color: colors.textMuted, fontWeight: '500' },
  sidebarFooter: {
    marginTop: 'auto',
    marginBottom: spacing(5),
    marginHorizontal: spacing(2),
    backgroundColor: sectionAccents.home.soft,
    borderRadius: radius.md,
    padding: spacing(3),
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing(2),
  },
  sidebarFooterText: { color: colors.primary, fontSize: 12, fontWeight: '600', flex: 1 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing(1.5),
    ...shadow.sm,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: spacing(1),
    minHeight: 48,
  },
  tabLabel: { fontSize: 10, color: colors.textMuted, fontWeight: '500' },
  labelActive: { fontWeight: '600' },
});
