import { useLocalSearchParams } from 'expo-router';

import { ExamFormScreen } from '../../../src/features/courses/screens/ExamFormScreen';

export default function ExamRoute() {
  const { examId } = useLocalSearchParams<{ examId: string }>();
  return <ExamFormScreen examId={String(examId)} />;
}
