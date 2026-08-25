import { AnalyticsCoursePickerScreen } from '../../src/features/analytics/screens/AnalyticsCoursePickerScreen';

/** Progress tab (M12): per-course analytics behind a course chooser. */
export default function ProgressScreen() {
  return (
    <AnalyticsCoursePickerScreen
      title="Progress"
      description="Pick a course to see your mastery map, trends and exam readiness."
      section="progress"
      icon="trending-up-outline"
    />
  );
}
