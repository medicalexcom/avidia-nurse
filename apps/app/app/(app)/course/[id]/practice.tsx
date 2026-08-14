import { useLocalSearchParams } from 'expo-router';

import { PracticeScreen } from '../../../../src/features/practice/screens/PracticeScreen';

export default function PracticeRoute() {
  const { id, mode } = useLocalSearchParams<{ id: string; mode?: string }>();
  return (
    <PracticeScreen courseId={String(id)} mode={mode === 'adaptive' ? 'adaptive' : 'practice'} />
  );
}
