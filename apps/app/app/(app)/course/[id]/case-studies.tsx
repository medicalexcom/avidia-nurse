import { useLocalSearchParams } from 'expo-router';
import { CaseStudiesScreen } from '../../../../src/features/aiLearning/screens/CaseStudiesScreen';
export default function CaseStudiesRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <CaseStudiesScreen courseId={String(id)} />;
}
