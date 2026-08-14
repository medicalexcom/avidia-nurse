import { useLocalSearchParams } from 'expo-router';

import { SimulationDebriefScreen } from '../../../../src/features/simulation/screens/SimulationDebriefScreen';

export default function SimulationDebriefRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SimulationDebriefScreen sessionId={String(id)} />;
}
