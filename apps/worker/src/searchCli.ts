import { SupabaseClient } from '@supabase/supabase-js';

import { describeLocator, EmbeddingProvider, SourceLocator } from '@avidia/rag';

import { toVectorLiteral } from './supabaseIndexerClient';

/**
 * Internal retrieval test interface (spec O). A developer-only CLI — never a
 * student-facing screen — for inspecting what retrieval returns for a course:
 *
 *   pnpm --filter @avidia/worker search -- --course <uuid> --query "DKA priority"
 *   optional: --document <uuid> --top-k 8 --min-similarity 0.2
 *
 * Runs server-side with the service role and the server-side embedding
 * provider (client bundles never hold provider keys). Prints chunk text,
 * scores, and provenance; content shown here is the developer's own test
 * data on an internal console, not a log stream.
 */

interface SearchRow {
  chunk_id: string;
  document_id: string;
  document_filename: string;
  ordinal: number;
  content: string;
  source_locator: SourceLocator;
  similarity: number;
  lexical_rank: number;
  score: number;
}

export interface SearchCliArgs {
  courseId: string;
  query: string;
  documentId: string | null;
  topK: number;
  minSimilarity: number;
}

export function parseSearchArgs(argv: readonly string[]): SearchCliArgs {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
  };
  const courseId = value('--course');
  const query = value('--query');
  if (!courseId || !query) {
    throw new Error(
      'Usage: search -- --course <uuid> --query "<text>" [--document <uuid>] [--top-k N] [--min-similarity X]'
    );
  }
  return {
    courseId,
    query,
    documentId: value('--document'),
    topK: Number(value('--top-k') ?? 8),
    minSimilarity: Number(value('--min-similarity') ?? 0),
  };
}

export async function runSearch(
  client: SupabaseClient,
  embeddings: EmbeddingProvider,
  args: SearchCliArgs,
  print: (line: string) => void = console.log
): Promise<void> {
  const meta = embeddings.metadata();
  print(`query: "${args.query}"  (provider ${meta.provider}/${meta.model})`);
  const queryEmbedding = await embeddings.embedQuery(args.query);
  const { data, error } = await client.rpc('search_course_chunks', {
    p_course_id: args.courseId,
    p_query: args.query,
    p_query_embedding: toVectorLiteral(queryEmbedding),
    p_top_k: args.topK,
    p_min_similarity: args.minSimilarity,
    p_document_id: args.documentId,
  });
  if (error) throw error;
  const rows = (data ?? []) as SearchRow[];
  if (rows.length === 0) {
    print('no results — a grounded answer for this query would be marked insufficient.');
    return;
  }
  rows.forEach((row, index) => {
    print('');
    print(
      `#${index + 1}  score=${row.score.toFixed(4)}  cosine=${row.similarity.toFixed(3)}  ` +
        `lexicalRank=${row.lexical_rank}`
    );
    print(`    ${row.document_filename} \u2014 ${describeLocator(row.source_locator)}`);
    print(`    chunk ${row.chunk_id} (ordinal ${row.ordinal}, document ${row.document_id})`);
    const preview = row.content.length > 240 ? `${row.content.slice(0, 240)}\u2026` : row.content;
    print(`    ${preview.replace(/\n/g, '\n    ')}`);
  });
}
