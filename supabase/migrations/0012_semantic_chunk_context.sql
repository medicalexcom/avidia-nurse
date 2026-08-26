-- Migration: Add semantic context to chunks for relationship preservation
-- Milestone: Skill #2 (Semantic Chunking & Context Window Optimization)
-- Corrected to match the current Avidia Nurse schema.

BEGIN;

-- Extend source_chunks table with semantic context
ALTER TABLE IF EXISTS public.source_chunks
ADD COLUMN IF NOT EXISTS semantic_context JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_source_chunks_semantic_context
  ON public.source_chunks USING GIN (semantic_context)
  WHERE semantic_context IS NOT NULL;

-- Track whether a chunk contains relationship chains
ALTER TABLE IF EXISTS public.source_chunks
ADD COLUMN IF NOT EXISTS has_relationship_chain BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_source_chunks_relationship_chain
  ON public.source_chunks(has_relationship_chain)
  WHERE has_relationship_chain = TRUE;

-- Track concept-term cross references for retrieval
CREATE TABLE IF NOT EXISTS public.chunk_concept_references (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  chunk_id UUID NOT NULL REFERENCES public.source_chunks(id) ON DELETE CASCADE,
  course_id UUID NOT NULL,
  concept_term TEXT NOT NULL,
  term_type TEXT DEFAULT 'concept',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(chunk_id, concept_term, term_type)
);

CREATE INDEX IF NOT EXISTS idx_chunk_concept_references_term
  ON public.chunk_concept_references(course_id, concept_term)
  WHERE term_type = 'concept';

CREATE INDEX IF NOT EXISTS idx_chunk_concept_references_chunk
  ON public.chunk_concept_references(chunk_id);

-- RLS follows the actual ownership chain:
-- source_chunks -> documents -> courses -> courses.user_id
ALTER TABLE public.chunk_concept_references ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chunk_concept_ref_select ON public.chunk_concept_references;
CREATE POLICY chunk_concept_ref_select ON public.chunk_concept_references
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.source_chunks sc
      JOIN public.documents d ON sc.document_id = d.id
      JOIN public.courses c ON c.id = d.course_id
      WHERE sc.id = chunk_id
        AND d.course_id = chunk_concept_references.course_id
        AND c.user_id = auth.uid()
    )
  );

-- Service-role function to index semantic context
CREATE OR REPLACE FUNCTION public.index_chunk_semantic_context(
  p_chunk_id UUID,
  p_course_id UUID,
  p_concept_terms TEXT[],
  p_has_relationship BOOLEAN DEFAULT FALSE
)
RETURNS void AS $$
BEGIN
  UPDATE public.source_chunks
  SET
    semantic_context = jsonb_build_object(
      'concept_terms', p_concept_terms,
      'has_relationship_chain', p_has_relationship,
      'indexed_at', NOW()
    ),
    has_relationship_chain = p_has_relationship
  WHERE id = p_chunk_id;

  INSERT INTO public.chunk_concept_references (chunk_id, course_id, concept_term, term_type)
  SELECT p_chunk_id, p_course_id, term, 'concept'
  FROM UNNEST(p_concept_terms) AS term
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

COMMIT;
