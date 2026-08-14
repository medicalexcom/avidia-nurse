import { useLocalSearchParams } from 'expo-router';

import { AnalyticsScreen } from '../../../../src/features/analytics/screens/AnalyticsScreen';

export default function AnalyticsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AnalyticsScreen courseId={String(id)} />;
}
