import { useLocalSearchParams } from 'expo-router';

import { PracticeScreen } from '../../../../src/features/practice/screens/PracticeScreen';

export default function PracticeRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PracticeScreen courseId={String(id)} />;
}
