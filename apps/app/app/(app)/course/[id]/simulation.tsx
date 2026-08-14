import { useLocalSearchParams } from 'expo-router';

import { SimulationLibraryScreen } from '../../../../src/features/simulation/screens/SimulationLibraryScreen';

export default function SimulationLibraryRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SimulationLibraryScreen courseId={String(id)} />;
}
