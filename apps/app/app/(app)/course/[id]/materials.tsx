import { useLocalSearchParams } from 'expo-router';

import { MaterialsScreen } from '../../../../src/features/materials/screens/MaterialsScreen';

export default function MaterialsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <MaterialsScreen courseId={String(id)} />;
}
