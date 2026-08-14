import { useLocalSearchParams } from 'expo-router';

import { ModesScreen } from '../../../../src/features/modes/screens/ModesScreen';

export default function ModesRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ModesScreen courseId={String(id)} />;
}
