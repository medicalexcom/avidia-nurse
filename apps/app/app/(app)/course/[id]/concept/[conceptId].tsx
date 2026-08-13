import { useLocalSearchParams } from 'expo-router';

import { ConceptDetailScreen } from '../../../../../src/features/concepts/screens/ConceptDetailScreen';

export default function ConceptDetailRoute() {
  const { id, conceptId } = useLocalSearchParams<{ id: string; conceptId: string }>();
  return <ConceptDetailScreen courseId={String(id)} conceptId={String(conceptId)} />;
}
