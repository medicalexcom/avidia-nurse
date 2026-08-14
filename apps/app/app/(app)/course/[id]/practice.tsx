import { useLocalSearchParams } from 'expo-router';

import { PracticeScreen } from '../../../../src/features/practice/screens/PracticeScreen';

export default function PracticeRoute() {
  const { id, mode, minutes, resume } = useLocalSearchParams<{
    id: string;
    mode?: string;
    minutes?: string;
    resume?: string;
  }>();
  const parsedMinutes = minutes ? Number(minutes) : null;
  return (
    <PracticeScreen
      courseId={String(id)}
      mode={mode === 'adaptive' ? 'adaptive' : 'practice'}
      minutes={Number.isFinite(parsedMinutes ?? NaN) ? parsedMinutes : null}
      resume={resume === '1'}
    />
  );
}
