import { useLocalSearchParams } from 'expo-router';

import { CourseDetailScreen } from '../../../../src/features/courses/screens/CourseDetailScreen';

export default function CourseDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <CourseDetailScreen courseId={String(id)} />;
}
