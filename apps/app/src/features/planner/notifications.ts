import { Platform } from 'react-native';

import type { ReminderInstruction } from '@avidia/planner';

/**
 * Local-notification adapter — M13 (spec AA/AB/AH/AI, ADR-0035).
 *
 * The pure engine emits `ReminderInstruction`s (what to say, when, where to
 * deep-link); this adapter only schedules them. Decisions baked in:
 *
 *   * LOCAL notifications only — no push infrastructure, no device tokens,
 *     no server fan-out (ADR-0035). Everything is scheduled on-device from
 *     the student's own plan.
 *   * Web is a graceful no-op (spec AI): the planner works fully without
 *     notifications; the settings screen explains reminders are app-only.
 *   * Permission is requested ONLY from the settings screen when a student
 *     turns a reminder on (spec AA — contextual, never on app launch).
 *   * Payloads carry countdowns and plan existence only — never performance
 *     data (spec AF/AP); bodies are produced by the engine which tests this.
 *
 * expo-notifications is imported lazily so the web bundle and jest never pay
 * for (or crash on) the native module.
 */

type NotificationsModule = typeof import('expo-notifications');

async function loadModule(): Promise<NotificationsModule | null> {
  if (Platform.OS === 'web') return null;
  try {
    return await import('expo-notifications');
  } catch {
    return null;
  }
}

/** True when local reminders can work on this platform at all. */
export function remindersSupported(): boolean {
  return Platform.OS !== 'web';
}

/**
 * Ask for permission in direct response to the student enabling a reminder
 * (spec AA). Returns false when denied or unsupported — callers keep the
 * toggle off and explain, they never nag.
 */
export async function requestReminderPermission(): Promise<boolean> {
  const notifications = await loadModule();
  if (!notifications) return false;
  const current = await notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const asked = await notifications.requestPermissionsAsync();
  return asked.granted;
}

/**
 * Replace all scheduled reminders with the given instructions (idempotent by
 * construction: cancel-then-schedule, so re-syncing after every plan change
 * never stacks duplicates — spec S/AA).
 */
export async function syncScheduledReminders(
  instructions: readonly ReminderInstruction[]
): Promise<number> {
  const notifications = await loadModule();
  if (!notifications) return 0;
  const permission = await notifications.getPermissionsAsync();
  if (!permission.granted) return 0;
  await notifications.cancelAllScheduledNotificationsAsync();
  let scheduled = 0;
  for (const instruction of instructions) {
    const fireAt = new Date(instruction.fireAt);
    if (Number.isNaN(fireAt.getTime()) || fireAt.getTime() <= Date.now()) continue;
    await notifications.scheduleNotificationAsync({
      identifier: instruction.id,
      content: {
        title: instruction.title,
        body: instruction.body,
        data: { url: instruction.deepLink },
      },
      trigger: { type: notifications.SchedulableTriggerInputTypes.DATE, date: fireAt },
    });
    scheduled += 1;
  }
  return scheduled;
}

/** Cancel everything (student disabled all reminders — spec AC). */
export async function clearScheduledReminders(): Promise<void> {
  const notifications = await loadModule();
  if (!notifications) return;
  await notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
}

/** Allowed in-app destinations for notification taps (spec AG). */
const VALID_DEEP_LINKS = new Set(['/planner', '/home', '/study']);

/** Validate a deep link before navigating; fall back to home (spec AG). */
export function safeDeepLink(url: unknown): string {
  return typeof url === 'string' && VALID_DEEP_LINKS.has(url) ? url : '/home';
}
