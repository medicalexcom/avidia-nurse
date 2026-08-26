-- Migration: Add Bloom's cognitive level tracking for progressive learning
-- Milestone: Skill #3 (Multi-Level Question Generation)
-- Spec: Track cognitive levels and learning progression per question
-- Corrected to match the repository schema: courses are referenced by id.

BEGIN;

-- Add cognitive level group tracking to questions
ALTER TABLE IF EXISTS public.questions
ADD COLUMN IF NOT EXISTS cognitive_level_group TEXT CHECK (cognitive_level_group IN ('foundational', 'intermediate', 'advanced')),
ADD COLUMN IF NOT EXISTS bloom_level_sequence SMALLINT DEFAULT 0;

-- Index for cognitive level queries (for study path optimization)
CREATE INDEX IF NOT EXISTS idx_questions_cognitive_level_group
  ON public.questions(course_id, cognitive_level_group)
  WHERE cognitive_level_group IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_questions_bloom_sequence
  ON public.questions(course_id, bloom_level_sequence)
  WHERE bloom_level_sequence > 0;

-- Table to track student progress through Bloom's levels
CREATE TABLE IF NOT EXISTS public.bloom_progression (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,

  -- Track mastery at each Bloom's level
  recall_mastery FLOAT DEFAULT 0,
  understanding_mastery FLOAT DEFAULT 0,
  application_mastery FLOAT DEFAULT 0,
  analysis_mastery FLOAT DEFAULT 0,
  evaluation_mastery FLOAT DEFAULT 0,
  synthesis_mastery FLOAT DEFAULT 0,

  -- Current level the student is studying
  current_level TEXT DEFAULT 'recall',

  -- Progression tracking
  completed_foundational BOOLEAN DEFAULT FALSE,
  completed_intermediate BOOLEAN DEFAULT FALSE,
  completed_advanced BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  UNIQUE(user_id, course_id, concept_id)
);

-- RLS for bloom_progression
ALTER TABLE public.bloom_progression ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bloom_progression_own_only ON public.bloom_progression;
CREATE POLICY bloom_progression_own_only ON public.bloom_progression
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Service-role function to update Bloom's progression
CREATE OR REPLACE FUNCTION public.update_bloom_progression(
  p_user_id UUID,
  p_course_id UUID,
  p_concept_id UUID,
  p_level TEXT,
  p_mastery_delta FLOAT
)
RETURNS void AS $$
BEGIN
  INSERT INTO public.bloom_progression (
    user_id, course_id, concept_id, current_level
  )
  VALUES (p_user_id, p_course_id, p_concept_id, p_level)
  ON CONFLICT (user_id, course_id, concept_id)
  DO NOTHING;

  -- Update mastery for the specific level
  CASE p_level
    WHEN 'recall' THEN
      UPDATE public.bloom_progression
      SET recall_mastery = LEAST(1, GREATEST(0, recall_mastery + p_mastery_delta))
      WHERE user_id = p_user_id AND course_id = p_course_id AND concept_id = p_concept_id;
    WHEN 'understanding' THEN
      UPDATE public.bloom_progression
      SET understanding_mastery = LEAST(1, GREATEST(0, understanding_mastery + p_mastery_delta))
      WHERE user_id = p_user_id AND course_id = p_course_id AND concept_id = p_concept_id;
    WHEN 'application' THEN
      UPDATE public.bloom_progression
      SET application_mastery = LEAST(1, GREATEST(0, application_mastery + p_mastery_delta))
      WHERE user_id = p_user_id AND course_id = p_course_id AND concept_id = p_concept_id;
    WHEN 'analysis' THEN
      UPDATE public.bloom_progression
      SET analysis_mastery = LEAST(1, GREATEST(0, analysis_mastery + p_mastery_delta))
      WHERE user_id = p_user_id AND course_id = p_course_id AND concept_id = p_concept_id;
    WHEN 'evaluation' THEN
      UPDATE public.bloom_progression
      SET evaluation_mastery = LEAST(1, GREATEST(0, evaluation_mastery + p_mastery_delta))
      WHERE user_id = p_user_id AND course_id = p_course_id AND concept_id = p_concept_id;
    WHEN 'synthesis' THEN
      UPDATE public.bloom_progression
      SET synthesis_mastery = LEAST(1, GREATEST(0, synthesis_mastery + p_mastery_delta))
      WHERE user_id = p_user_id AND course_id = p_course_id AND concept_id = p_concept_id;
  END CASE;

  -- Update progression completion flags
  UPDATE public.bloom_progression
  SET
    completed_foundational = (recall_mastery >= 0.7 AND understanding_mastery >= 0.7),
    completed_intermediate = (application_mastery >= 0.7 AND analysis_mastery >= 0.7),
    completed_advanced = (evaluation_mastery >= 0.7 AND synthesis_mastery >= 0.7),
    updated_at = NOW()
  WHERE user_id = p_user_id AND course_id = p_course_id AND concept_id = p_concept_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

COMMIT;
