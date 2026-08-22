import {
  createQuestionGenerationProviderFromEnv,
  QuestionGenerationProvider,
} from '@avidia/assessment';
import {
  ConceptExtractionProvider,
  createConceptExtractionProviderFromEnv,
} from '@avidia/knowledge';
import { createEmbeddingProviderFromEnv, EmbeddingProvider } from '@avidia/rag';

import { drainIndexQueue, indexNextDocument, IndexerClient, STALE_INDEXING_MS } from './indexer';
import {
  drainKnowledgeQueue,
  extractNextDocument,
  KnowledgeClient,
  STALE_KNOWLEDGE_MS,
} from './knowledge';
import { drainQueue, processNextDocument, STALE_PROCESSING_MS, WorkerClient } from './processor';
import {
  drainQuestionQueue,
  generateNextDocument,
  QuestionsClient,
  STALE_QUESTIONS_MS,
} from './questions';
import { parseSearchArgs, runSearch } from './searchCli';
import { createSupabaseIndexerClient } from './supabaseIndexerClient';
import { createSupabaseKnowledgeClient } from './supabaseKnowledgeClient';
import { createSupabaseQuestionsClient } from './supabaseQuestionsClient';
import { createSupabaseWorkerClient, supabaseClientFromEnv } from './supabaseWorkerClient';
import {
  createSupabaseLearningGenerationClient,
  processLearningRequest,
  type LearningGenerationClient,
  STALE_LEARNING_MS,
} from './learningGeneration';

/**
 * Worker entry point (spec J; M5 spec I/O).
 *
 *   pnpm --filter @avidia/worker start          poll loop (every 5 seconds)
 *   pnpm --filter @avidia/worker start:once     drain both queues, then exit
 *   pnpm --filter @avidia/worker search -- --course <uuid> --query "..."
 *                                               internal retrieval inspector
 *
 * Each cycle runs the M4 extraction stage (queued → ready), the M5 indexing
 * stage (ready + pending → indexed), the M6 concept-extraction stage
 * (indexed + pending → knowledge ready), and the M7 question-generation stage
 * (knowledge ready + pending → questions ready), so an upload flows to
 * practice-ready without operator action.
 *
 * Logging policy (spec O): document ids, statuses, and counts only — never
 * file content, storage keys, tokens, or credentials.
 */

const POLL_INTERVAL_MS = 5000;

function log(message: string): void {
  console.log(`[worker ${new Date().toISOString()}] ${message}`);
}

/**
 * Safely describe a thrown value for logs. Supabase/Postgrest errors are
 * plain objects, not `Error` instances, so `String(error)` on them collapses
 * to the unhelpful "[object Object]" — JSON.stringify surfaces their actual
 * code/message/hint instead. Never includes prompt content or secrets: the
 * only inputs here are error shapes from Supabase/network/provider clients.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function sweepStale(
  client: WorkerClient,
  indexer: IndexerClient,
  knowledge: KnowledgeClient,
  questions: QuestionsClient,
  learning: LearningGenerationClient
): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  const recovered = await client.recoverStaleProcessing(staleBefore);
  if (recovered > 0) {
    log(`recovered ${recovered} stale processing document(s)`);
  }
  const staleIndexBefore = new Date(Date.now() - STALE_INDEXING_MS).toISOString();
  const requeued = await indexer.recoverStaleIndexing(staleIndexBefore);
  if (requeued > 0) {
    log(`requeued ${requeued} stale indexing document(s)`);
  }
  const staleKnowledgeBefore = new Date(Date.now() - STALE_KNOWLEDGE_MS).toISOString();
  const reExtract = await knowledge.recoverStaleKnowledge(staleKnowledgeBefore);
  if (reExtract > 0) {
    log(`requeued ${reExtract} stale concept-extraction document(s)`);
  }
  const staleQuestionsBefore = new Date(Date.now() - STALE_QUESTIONS_MS).toISOString();
  const reGenerate = await questions.recoverStaleQuestions(staleQuestionsBefore);
  if (reGenerate > 0) {
    log(`requeued ${reGenerate} stale question-generation document(s)`);
  }
  const staleLearningBefore = new Date(Date.now() - STALE_LEARNING_MS).toISOString();
  const recoveredLearning = await learning.recoverStale(staleLearningBefore);
  if (recoveredLearning > 0) {
    log(`recovered ${recoveredLearning} stale personalized-learning request(s)`);
  }
}

async function runOnce(
  client: WorkerClient,
  indexer: IndexerClient,
  embeddings: EmbeddingProvider,
  knowledge: KnowledgeClient,
  concepts: ConceptExtractionProvider,
  questions: QuestionsClient,
  questionProvider: QuestionGenerationProvider,
  learning: ReturnType<typeof createSupabaseLearningGenerationClient>,
  apiKey: string
): Promise<void> {
  await sweepStale(client, indexer, knowledge, questions, learning);
  const outcomes = await drainQueue(client);
  for (const outcome of outcomes) {
    if (outcome.status === 'ready') {
      log(`document ${outcome.documentId} ready (${outcome.sectionCount} sections)`);
    } else if (outcome.status === 'failed') {
      log(`document ${outcome.documentId} failed`);
    }
  }
  log(`drained queue: ${outcomes.length} document(s) processed`);
  const indexed = await drainIndexQueue(indexer, embeddings);
  for (const outcome of indexed) {
    if (outcome.status === 'indexed') {
      log(
        `document ${outcome.documentId} indexed ` +
          `(${outcome.chunkCount} chunks, ~${outcome.tokenEstimate} tokens embedded)`
      );
    } else if (outcome.status === 'failed') {
      log(`document ${outcome.documentId} indexing failed`);
    }
  }
  log(`drained index queue: ${indexed.length} document(s) indexed`);
  const extracted = await drainKnowledgeQueue(knowledge, concepts);
  for (const outcome of extracted) {
    if (outcome.status === 'extracted') {
      log(
        `document ${outcome.documentId} knowledge ready ` +
          `(${outcome.concepts} new concepts, ${outcome.links} links, ` +
          `${outcome.relationships} relationships)`
      );
    } else if (outcome.status === 'skipped') {
      log(`document ${outcome.documentId} knowledge unchanged (fingerprint match, no AI call)`);
    } else if (outcome.status === 'failed') {
      log(`document ${outcome.documentId} concept extraction failed`);
    }
  }
  log(`drained knowledge queue: ${extracted.length} document(s) extracted`);
  const generated = await drainQuestionQueue(questions, questionProvider);
  for (const outcome of generated) {
    if (outcome.status === 'generated') {
      log(
        `document ${outcome.documentId} questions ready ` +
          `(${outcome.inserted} inserted, ${outcome.duplicates} duplicates, ` +
          `${outcome.rejected} rejected, ${outcome.flagged} flagged, ${outcome.links} links)`
      );
    } else if (outcome.status === 'skipped') {
      log(`document ${outcome.documentId} questions unchanged (fingerprint match, no AI call)`);
    } else if (outcome.status === 'failed') {
      log(`document ${outcome.documentId} question generation failed`);
    }
  }
  log(`drained question queue: ${generated.length} document(s) generated`);
  let learningCount = 0;
  try {
    while ((await processLearningRequest(learning, embeddings, apiKey, process.env)) !== 'idle') {
      learningCount += 1;
    }
  } catch (error) {
    // A claim failure (the only call in processLearningRequest not already
    // guarded by its own try/catch) must not abort the whole scheduled run
    // before it finishes — the next run will retry any remaining requests.
    log(`personalized learning queue error: ${describeError(error)}`);
  }
  log(`drained personalized learning queue: ${learningCount} request(s)`);
}

async function runLoop(
  client: WorkerClient,
  indexer: IndexerClient,
  embeddings: EmbeddingProvider,
  knowledge: KnowledgeClient,
  concepts: ConceptExtractionProvider,
  questions: QuestionsClient,
  questionProvider: QuestionGenerationProvider,
  learning: ReturnType<typeof createSupabaseLearningGenerationClient>,
  apiKey: string
): Promise<never> {
  log(`polling every ${POLL_INTERVAL_MS / 1000}s`);
  let lastSweep = 0;
  for (;;) {
    try {
      if (
        Date.now() - lastSweep >
        Math.min(
          STALE_PROCESSING_MS,
          STALE_INDEXING_MS,
          STALE_KNOWLEDGE_MS,
          STALE_QUESTIONS_MS,
          STALE_LEARNING_MS
        )
      ) {
        await sweepStale(client, indexer, knowledge, questions, learning);
        lastSweep = Date.now();
      }
      const outcome = await processNextDocument(client);
      if (outcome.status === 'ready') {
        log(`document ${outcome.documentId} ready (${outcome.sectionCount} sections)`);
        continue; // keep draining without waiting
      }
      if (outcome.status === 'failed') {
        log(`document ${outcome.documentId} failed`);
        continue;
      }
      const indexOutcome = await indexNextDocument(indexer, embeddings);
      if (indexOutcome.status === 'indexed') {
        log(
          `document ${indexOutcome.documentId} indexed ` +
            `(${indexOutcome.chunkCount} chunks, ~${indexOutcome.tokenEstimate} tokens embedded)`
        );
        continue;
      }
      if (indexOutcome.status === 'failed') {
        log(`document ${indexOutcome.documentId} indexing failed`);
        continue;
      }
      const knowledgeOutcome = await extractNextDocument(knowledge, concepts);
      if (knowledgeOutcome.status === 'extracted') {
        log(
          `document ${knowledgeOutcome.documentId} knowledge ready ` +
            `(${knowledgeOutcome.concepts} new concepts, ${knowledgeOutcome.links} links, ` +
            `${knowledgeOutcome.relationships} relationships)`
        );
        continue;
      }
      if (knowledgeOutcome.status === 'skipped') {
        log(
          `document ${knowledgeOutcome.documentId} knowledge unchanged ` +
            '(fingerprint match, no AI call)'
        );
        continue;
      }
      if (knowledgeOutcome.status === 'failed') {
        log(`document ${knowledgeOutcome.documentId} concept extraction failed`);
        continue;
      }
      const questionsOutcome = await generateNextDocument(questions, questionProvider);
      if (questionsOutcome.status === 'generated') {
        log(
          `document ${questionsOutcome.documentId} questions ready ` +
            `(${questionsOutcome.inserted} inserted, ${questionsOutcome.duplicates} duplicates, ` +
            `${questionsOutcome.rejected} rejected, ${questionsOutcome.flagged} flagged, ` +
            `${questionsOutcome.links} links)`
        );
        continue;
      }
      if (questionsOutcome.status === 'skipped') {
        log(
          `document ${questionsOutcome.documentId} questions unchanged ` +
            '(fingerprint match, no AI call)'
        );
        continue;
      }
      if (questionsOutcome.status === 'failed') {
        log(`document ${questionsOutcome.documentId} question generation failed`);
        continue;
      }
      const learningOutcome = await processLearningRequest(
        learning,
        embeddings,
        apiKey,
        process.env
      );
      if (learningOutcome !== 'idle') continue;
    } catch (error) {
      log(`worker error: ${describeError(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main(): Promise<void> {
  const supabase = supabaseClientFromEnv();
  const embeddings = createEmbeddingProviderFromEnv(process.env);

  if (process.argv.includes('--search')) {
    await runSearch(supabase, embeddings, parseSearchArgs(process.argv));
    return;
  }

  const client = createSupabaseWorkerClient(supabase);
  const indexer = createSupabaseIndexerClient(supabase, embeddings);
  const knowledge = createSupabaseKnowledgeClient(supabase);
  const concepts = createConceptExtractionProviderFromEnv(process.env);
  const questions = createSupabaseQuestionsClient(supabase);
  const questionProvider = createQuestionGenerationProviderFromEnv(process.env);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Personalized learning generation requires OPENAI_API_KEY.');
  const learning = createSupabaseLearningGenerationClient(supabase, embeddings);
  if (process.argv.includes('--once')) {
    await runOnce(
      client,
      indexer,
      embeddings,
      knowledge,
      concepts,
      questions,
      questionProvider,
      learning,
      apiKey
    );
    return;
  }
  await runLoop(
    client,
    indexer,
    embeddings,
    knowledge,
    concepts,
    questions,
    questionProvider,
    learning,
    apiKey
  );
}

main().catch((error) => {
  log(`fatal: ${describeError(error)}`);
  process.exit(1);
});
