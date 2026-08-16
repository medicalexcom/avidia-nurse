import { useLocalSearchParams } from 'expo-router';
import { AskAvidiaScreen } from '../../../../src/features/aiLearning/screens/AskAvidiaScreen';
export default function AskAvidiaRoute() {
  const { id, conceptId, questionId, contextType, sessionId, prompt } = useLocalSearchParams<{
    id: string;
    conceptId?: string;
    questionId?: string;
    contextType?: string;
    sessionId?: string;
    prompt?: string;
  }>();
  return (
    <AskAvidiaScreen
      courseId={String(id)}
      context={{ conceptId, questionId, contextType, sessionId }}
      initialPrompt={prompt}
    />
  );
}
