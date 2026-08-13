import { createEmbeddingProviderFromEnv, EmbeddingProvider } from '@avidia/rag';

import { drainIndexQueue, indexNextDocument, IndexerClient, STALE_INDEXING_MS } from './indexer';
import { drainQueue, processNextDocument, STALE_PROCESSING_MS, WorkerClient } from './processor';
import { parseSearchArgs, runSearch } from './searchCli';
import { createSupabaseIndexerClient } from './supabaseIndexerClient';
import { createSupabaseWorkerClient, supabaseClientFromEnv } from './supabaseWorkerClient';

/**
 * Worker entry point (spec J; M5 spec I/O).
 *
 *   pnpm --filter @avidia/worker start          poll loop (every 5 seconds)
 *   pnpm --filter @avidia/worker start:once     drain both queues, then exit
 *   pnpm --filter @avidia/worker search -- --course <uuid> --query "..."
 *                                               internal retrieval inspector
 *
 * Each cycle runs the M4 extraction stage (queued → ready) and then the M5
 * indexing stage (ready + pending → indexed), so an upload flows to
 * retrieval-ready without operator action.
 *
 * Logging policy (spec O): document ids, statuses, and counts only — never
 * file content, storage keys, tokens, or credentials.
 */

const POLL_INTERVAL_MS = 5000;

function log(message: string): void {
  console.log(`[worker ${new Date().toISOString()}] ${message}`);
}

async function sweepStale(client: WorkerClient, indexer: IndexerClient): Promise<void> {
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
}

async function runOnce(
  client: WorkerClient,
  indexer: IndexerClient,
  embeddings: EmbeddingProvider
): Promise<void> {
  await sweepStale(client, indexer);
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
}

async function runLoop(
  client: WorkerClient,
  indexer: IndexerClient,
  embeddings: EmbeddingProvider
): Promise<never> {
  log(`polling every ${POLL_INTERVAL_MS / 1000}s`);
  let lastSweep = 0;
  for (;;) {
    try {
      if (Date.now() - lastSweep > Math.min(STALE_PROCESSING_MS, STALE_INDEXING_MS)) {
        await sweepStale(client, indexer);
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
    } catch (error) {
      log(`worker error: ${error instanceof Error ? error.message : String(error)}`);
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
  if (process.argv.includes('--once')) {
    await runOnce(client, indexer, embeddings);
    return;
  }
  await runLoop(client, indexer, embeddings);
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
