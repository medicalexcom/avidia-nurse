import { useLocalSearchParams } from 'expo-router';

import { StudyDashboardScreen } from '../../../../src/features/study/screens/StudyDashboardScreen';

export default function StudyRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <StudyDashboardScreen courseId={String(id)} />;
}
