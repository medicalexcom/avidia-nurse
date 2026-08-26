-- Migration: Add semantic context to chunks for relationship preservation
-- Milestone: Skill #2 (Semantic Chunking & Context Window Optimization)
-- Spec: Store concept terms and relationship chains in chunks for better retrieval

BEGIN;

-- Extend source_chunks table with semantic context
ALTER TABLE IF EXISTS public.source_chunks
ADD COLUMN IF NOT EXISTS semantic_context JSONB DEFAULT NULL;

-- Create index for semantic context queries
CREATE INDEX IF NOT EXISTS idx_source_chunks_semantic_context
  ON public.source_chunks USING GIN (semantic_context)
  WHERE semantic_context IS NOT NULL;

-- Add column to track if chunk contains relationship chains
ALTER TABLE IF EXISTS public.source_chunks
ADD COLUMN IF NOT EXISTS has_relationship_chain BOOLEAN DEFAULT FALSE;

-- Add index for relationship chain queries
CREATE INDEX IF NOT EXISTS idx_source_chunks_relationship_chain
  ON public.source_chunks(has_relationship_chain)
  WHERE has_relationship_chain = TRUE;

-- Table to track concept term cross-references
-- (which chunks mention concept terms related to prerequisites/causes)
CREATE TABLE IF NOT EXISTS public.chunk_concept_references (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  chunk_id UUID NOT NULL REFERENCES public.source_chunks(id) ON DELETE CASCADE,
  course_id UUID NOT NULL,
  concept_term TEXT NOT NULL,
  term_type TEXT DEFAULT 'concept', -- 'concept', 'relationship', 'prerequisite'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(chunk_id, concept_term, term_type)
);

-- Index for finding chunks that mention specific concepts
CREATE INDEX IF NOT EXISTS idx_chunk_concept_references_term
  ON public.chunk_concept_references(course_id, concept_term)
  WHERE term_type = 'concept';

CREATE INDEX IF NOT EXISTS idx_chunk_concept_references_chunk
  ON public.chunk_concept_references(chunk_id);

-- RLS for chunk_concept_references: inherited from chunk's course
ALTER TABLE public.chunk_concept_references ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chunk_concept_ref_select ON public.chunk_concept_references;
CREATE POLICY chunk_concept_ref_select ON public.chunk_concept_references
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.source_chunks sc
      JOIN public.documents d ON sc.document_id = d.id
      WHERE sc.id = chunk_id
        AND d.course_id = chunk_concept_references.course_id
        AND d.owner_id = auth.uid()
    )
  );

-- Service-role function to index semantic context
-- Called after chunks are created
CREATE OR REPLACE FUNCTION public.index_chunk_semantic_context(
  p_chunk_id UUID,
  p_course_id UUID,
  p_concept_terms TEXT[],
  p_has_relationship BOOLEAN DEFAULT FALSE
)
RETURNS void AS $$
BEGIN
  -- Update chunk metadata
  UPDATE public.source_chunks
  SET
    semantic_context = jsonb_build_object(
      'concept_terms', p_concept_terms,
      'has_relationship_chain', p_has_relationship,
      'indexed_at', NOW()
    ),
    has_relationship_chain = p_has_relationship
  WHERE id = p_chunk_id;

  -- Insert concept term cross-references
  INSERT INTO public.chunk_concept_references (chunk_id, course_id, concept_term, term_type)
  SELECT p_chunk_id, p_course_id, term, 'concept'
  FROM UNNEST(p_concept_terms) AS term
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;
