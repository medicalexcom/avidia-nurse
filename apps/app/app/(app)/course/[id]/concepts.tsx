import { useLocalSearchParams } from 'expo-router';

import { ConceptsScreen } from '../../../../src/features/concepts/screens/ConceptsScreen';

export default function ConceptsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ConceptsScreen courseId={String(id)} />;
}
