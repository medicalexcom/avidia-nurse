import { useLocalSearchParams } from 'expo-router';

import { AddMaterialScreen } from '../../../../src/features/materials/screens/AddMaterialScreen';

export default function AddMaterialRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AddMaterialScreen courseId={String(id)} />;
}
