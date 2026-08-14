import { useLocalSearchParams } from 'expo-router';

import { SimulationSessionScreen } from '../../../../src/features/simulation/screens/SimulationSessionScreen';

export default function SimulationSessionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SimulationSessionScreen sessionId={String(id)} />;
}
