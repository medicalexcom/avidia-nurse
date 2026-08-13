import { drainQueue, processNextDocument, STALE_PROCESSING_MS, WorkerClient } from './processor';
import { createSupabaseWorkerClient, supabaseClientFromEnv } from './supabaseWorkerClient';

/**
 * Worker entry point (spec J).
 *
 *   pnpm --filter @avidia/worker start          poll loop (every 5 seconds)
 *   pnpm --filter @avidia/worker start:once     drain the queue, then exit
 *
 * Logging policy (spec O): document ids, statuses, and counts only — never
 * file content, storage keys, tokens, or credentials.
 */

const POLL_INTERVAL_MS = 5000;

function log(message: string): void {
  console.log(`[worker ${new Date().toISOString()}] ${message}`);
}

async function sweepStale(client: WorkerClient): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  const recovered = await client.recoverStaleProcessing(staleBefore);
  if (recovered > 0) {
    log(`recovered ${recovered} stale processing document(s)`);
  }
}

async function runOnce(client: WorkerClient): Promise<void> {
  await sweepStale(client);
  const outcomes = await drainQueue(client);
  for (const outcome of outcomes) {
    if (outcome.status === 'ready') {
      log(`document ${outcome.documentId} ready (${outcome.sectionCount} sections)`);
    } else if (outcome.status === 'failed') {
      log(`document ${outcome.documentId} failed`);
    }
  }
  log(`drained queue: ${outcomes.length} document(s) processed`);
}

async function runLoop(client: WorkerClient): Promise<never> {
  log(`polling every ${POLL_INTERVAL_MS / 1000}s`);
  let lastSweep = 0;
  for (;;) {
    try {
      if (Date.now() - lastSweep > STALE_PROCESSING_MS) {
        await sweepStale(client);
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
    } catch (error) {
      log(`worker error: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const client = createSupabaseWorkerClient(supabaseClientFromEnv());
  if (once) {
    await runOnce(client);
    return;
  }
  await runLoop(client);
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
