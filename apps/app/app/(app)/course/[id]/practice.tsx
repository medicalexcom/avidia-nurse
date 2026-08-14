import { useLocalSearchParams } from 'expo-router';

import { isModeId } from '../../../../src/features/modes/registry';
import { PracticeScreen } from '../../../../src/features/practice/screens/PracticeScreen';

export default function PracticeRoute() {
  const { id, mode, minutes, resume } = useLocalSearchParams<{
    id: string;
    mode?: string;
    minutes?: string;
    resume?: string;
  }>();
  const parsedMinutes = minutes ? Number(minutes) : null;
  // M10: study-mode ids are valid modes; anything unknown falls back to
  // plain practice rather than erroring.
  const parsedMode = mode === 'adaptive' || isModeId(mode) ? mode : 'practice';
  return (
    <PracticeScreen
      courseId={String(id)}
      mode={parsedMode}
      minutes={Number.isFinite(parsedMinutes ?? NaN) ? parsedMinutes : null}
      resume={resume === '1'}
    />
  );
}
