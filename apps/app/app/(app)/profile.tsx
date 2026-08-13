import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../src/features/auth/AuthProvider';
import { mapAuthError } from '../../src/features/auth/errors';
import {
  PROGRAM_TYPES,
  fetchOwnProfile,
  updateOwnProfile,
  type Profile,
  type ProgramType,
} from '../../src/features/profile/profileApi';
import { getSupabase } from '../../src/lib/supabase';
import { ErrorBanner, Field, PrimaryButton, Screen } from '../../src/ui/components';
import { colors, spacing } from '../../src/ui/theme';

const PROGRAM_LABELS: Record<ProgramType, string> = {
  absn: 'ABSN',
  bsn: 'BSN',
  adn: 'ADN',
  other: 'Other',
};

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [timezone, setTimezone] = useState('');
  const [programType, setProgramType] = useState<ProgramType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const client = getSupabase();
    if (!client || !user) {
      setLoading(false);
      return;
    }
    try {
      const data = await fetchOwnProfile(client, user.id);
      setProfile(data);
      setTimezone(data?.timezone ?? '');
      setProgramType((data?.program_type as ProgramType | null) ?? null);
      setError(null);
    } catch (err) {
      setError(mapAuthError(err).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const onSave = async () => {
    const client = getSupabase();
    if (!client || !user) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const updated = await updateOwnProfile(client, user.id, {
        timezone: timezone.trim() || null,
        program_type: programType,
      });
      setProfile(updated);
      setNotice('Profile saved.');
    } catch (err) {
      setError(mapAuthError(err).message);
    } finally {
      setSaving(false);
    }
  };

  const onSignOut = async () => {
    const failure = await signOut();
    if (failure) setError(failure.message);
  };

  return (
    <Screen title="Profile & Settings">
      <ErrorBanner message={error} />
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <View style={styles.card}>
        <Text style={styles.label}>Email</Text>
        <Text style={styles.value}>{user?.email ?? '—'}</Text>
        <Text style={styles.label}>Member since</Text>
        <Text style={styles.value}>
          {profile?.created_at ? new Date(profile.created_at).toLocaleDateString() : '—'}
        </Text>
      </View>

      {loading ? (
        <Text style={styles.muted}>Loading your profile…</Text>
      ) : (
        <>
          <Field
            label="Timezone"
            value={timezone}
            onChangeText={setTimezone}
            autoCapitalize="none"
            placeholder="e.g. America/New_York"
          />
          <Text style={styles.label}>Program type</Text>
          <View style={styles.chips}>
            {PROGRAM_TYPES.map((pt) => {
              const selected = programType === pt;
              return (
                <Pressable
                  key={pt}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => setProgramType(selected ? null : pt)}
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>
                    {PROGRAM_LABELS[pt]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <PrimaryButton label="Save changes" onPress={onSave} busy={saving} />
        </>
      )}

      <Pressable accessibilityRole="button" onPress={onSignOut} style={styles.signOut}>
        <Text style={styles.signOutLabel}>Sign out</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(4),
    marginBottom: spacing(5),
  },
  label: { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: spacing(1) },
  value: { fontSize: 15, color: colors.textMuted, marginBottom: spacing(3) },
  muted: { color: colors.textMuted, fontSize: 14 },
  notice: { color: '#15803d', fontSize: 14, marginBottom: spacing(3) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2), marginBottom: spacing(4) },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: 999,
    paddingHorizontal: spacing(4),
    paddingVertical: spacing(2),
  },
  chipSelected: { backgroundColor: colors.badge, borderColor: colors.primary },
  chipLabel: { color: colors.textMuted, fontSize: 14 },
  chipLabelSelected: { color: colors.primary, fontWeight: '600' },
  signOut: { marginTop: spacing(8), alignItems: 'center', paddingVertical: spacing(3) },
  signOutLabel: { color: colors.danger, fontSize: 15, fontWeight: '600' },
});
