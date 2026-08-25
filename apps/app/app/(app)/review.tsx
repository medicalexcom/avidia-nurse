import { ReviewQueueScreen } from '../../src/features/review/screens/ReviewQueueScreen';

/**
 * Content-review queue (roadmap: "RN validation before canonical promotion").
 * The screen itself enforces access — the edge function it calls checks
 * `profiles.role = 'reviewer'` server-side — so this route is reachable by
 * URL but shows a plain "Reviewer access required" message to anyone else.
 * The Profile screen only links here when the caller's own profile already
 * has that role.
 */
export default function ReviewRoute() {
  return <ReviewQueueScreen />;
}
