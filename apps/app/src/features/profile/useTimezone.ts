import { useEffect, useState } from 'react';

import { isValidTimeZone } from '@avidia/domain';

import { useAuth } from '../auth/AuthProvider';
import { getSupabase } from '../../lib/supabase';
import { fetchOwnProfile } from './profileApi';

/** The device's IANA timezone — never a hard-coded default (no "US Central"). */
export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && isValidTimeZone(tz)) return tz;
  } catch {
    // fall through
  }
  return 'UTC';
}

/**
 * The timezone all exam times are displayed in: the student's profile
 * timezone when set and valid, otherwise the device timezone. Starts with the
 * device timezone immediately (no flash of UTC) and upgrades once the profile
 * loads.
 */
export function useUserTimezone(): string {
  const { user } = useAuth();
  const [timezone, setTimezone] = useState<string>(deviceTimeZone);

  useEffect(() => {
    let cancelled = false;
    const client = getSupabase();
    if (!client || !user) return;
    fetchOwnProfile(client, user.id)
      .then((profile) => {
        const tz = profile?.timezone?.trim();
        if (!cancelled && tz && isValidTimeZone(tz)) setTimezone(tz);
      })
      .catch(() => {
        // Non-fatal: keep the device timezone.
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  return timezone;
}
