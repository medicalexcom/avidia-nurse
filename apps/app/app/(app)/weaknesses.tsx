import { AnalyticsCoursePickerScreen } from '../../src/features/analytics/screens/AnalyticsCoursePickerScreen';

/**
 * Weaknesses tab (M12): opens the per-course analytics page, whose "Needs
 * attention" section lists evidence-backed weak concepts with their reasons.
 */
export default function WeaknessesScreen() {
  return (
    <AnalyticsCoursePickerScreen
      title="Weaknesses"
      description="Pick a course to see which concepts need attention and why."
    />
  );
}
