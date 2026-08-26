-- Migration: Add prerequisite relationship tracking for learning path scaffolding
-- Milestone: M16 (Concept Prerequisites)
-- Spec: Store prerequisite strength and flags for concept dependency gating
--
-- Current schema notes:
--   courses uses user_id (not owner_id)
--   concept_relationships uses source_concept_id (not source_id)
--   concepts and concept_mastery are course-scoped, but their UUID ids are
--   already primary keys, so simple FKs are sufficient here. Course ownership
--   is enforced by RLS and the course_id relationship.

BEGIN;

-- ALTER concept_relationships to add prerequisite fields
ALTER TABLE IF EXISTS public.concept_relationships
ADD COLUMN IF NOT EXISTS prerequisite_strength INTEGER CHECK (
  prerequisite_strength IS NULL OR (prerequisite_strength >= 1 AND prerequisite_strength <= 10)
),
ADD COLUMN IF NOT EXISTS is_prerequisite BOOLEAN DEFAULT FALSE;

-- Create indexes for faster prerequisite lookups
CREATE INDEX IF NOT EXISTS idx_concept_relationships_prerequisite
  ON public.concept_relationships(target_concept_id, is_prerequisite)
  WHERE is_prerequisite = TRUE;

CREATE INDEX IF NOT EXISTS idx_concept_relationships_strength
  ON public.concept_relationships(prerequisite_strength)
  WHERE is_prerequisite = TRUE AND prerequisite_strength >= 8;

-- Table to track prerequisite satisfaction per user
CREATE TABLE IF NOT EXISTS public.prerequisite_satisfaction (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,
  prerequisite_concept_id UUID NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,
  is_satisfied BOOLEAN DEFAULT FALSE,
  current_prerequisite_mastery FLOAT,
  last_checked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  UNIQUE(user_id, course_id, concept_id, prerequisite_concept_id)
);

-- RLS for prerequisite_satisfaction: users read/write only their own records
ALTER TABLE public.prerequisite_satisfaction ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prereq_satisfaction_own_only ON public.prerequisite_satisfaction;
CREATE POLICY prereq_satisfaction_own_only ON public.prerequisite_satisfaction
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Service-role function to compute and store prerequisite satisfaction
-- Called after mastery updates to reflect current prerequisite state
CREATE OR REPLACE FUNCTION public.refresh_prerequisite_satisfaction(
  p_user_id UUID,
  p_course_id UUID
)
RETURNS void AS $$
DECLARE
  v_concept_rec RECORD;
  v_prereq_rec RECORD;
  v_prereq_mastery FLOAT;
BEGIN
  -- For each concept in the course
  FOR v_concept_rec IN
    SELECT DISTINCT c.id AS concept_id
    FROM public.concepts c
    WHERE c.course_id = p_course_id
  LOOP
    -- For each prerequisite of this concept
    FOR v_prereq_rec IN
      SELECT cr.source_concept_id, cr.prerequisite_strength
      FROM public.concept_relationships cr
      WHERE cr.target_concept_id = v_concept_rec.concept_id
        AND cr.is_prerequisite = TRUE
    LOOP
      -- Get current mastery of the prerequisite
      SELECT cm.mastery INTO v_prereq_mastery
      FROM public.concept_mastery cm
      WHERE cm.user_id = p_user_id
        AND cm.course_id = p_course_id
        AND cm.concept_id = v_prereq_rec.source_concept_id
      LIMIT 1;

      -- Upsert satisfaction record
      INSERT INTO public.prerequisite_satisfaction (
        user_id, course_id, concept_id, prerequisite_concept_id,
        is_satisfied, current_prerequisite_mastery, last_checked_at
      )
      VALUES (
        p_user_id, p_course_id, v_concept_rec.concept_id, v_prereq_rec.source_concept_id,
        COALESCE(v_prereq_mastery, 0) >= 0.7,
        COALESCE(v_prereq_mastery, 0),
        NOW()
      )
      ON CONFLICT (user_id, course_id, concept_id, prerequisite_concept_id)
      DO UPDATE SET
        is_satisfied = COALESCE(v_prereq_mastery, 0) >= 0.7,
        current_prerequisite_mastery = COALESCE(v_prereq_mastery, 0),
        last_checked_at = NOW();
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Trigger to refresh prerequisite satisfaction after mastery updates
CREATE OR REPLACE FUNCTION public.trigger_refresh_prerequisite_satisfaction()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM public.refresh_prerequisite_satisfaction(NEW.user_id, NEW.course_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_refresh_prerequisites_on_mastery ON public.concept_mastery;
CREATE TRIGGER trg_refresh_prerequisites_on_mastery
AFTER INSERT OR UPDATE ON public.concept_mastery
FOR EACH ROW
EXECUTE FUNCTION public.trigger_refresh_prerequisite_satisfaction();

COMMIT;
