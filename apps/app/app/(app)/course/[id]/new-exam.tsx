import { useLocalSearchParams } from 'expo-router';

import { ExamFormScreen } from '../../../../src/features/courses/screens/ExamFormScreen';

export default function NewExamRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ExamFormScreen courseId={String(id)} />;
}
