import { useLocalSearchParams } from 'expo-router';

import { CourseFormScreen } from '../../../../src/features/courses/screens/CourseFormScreen';

export default function EditCourseRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <CourseFormScreen courseId={String(id)} />;
}
