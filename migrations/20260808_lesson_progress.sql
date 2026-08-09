-- =========================================================================
-- INTERNNETRA LMS MODULE 5: LESSON PROGRESS & CROSS-DEVICE SYNCHRONIZATION
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.lesson_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  enrollment_id UUID NOT NULL REFERENCES public.enrollments(id) ON DELETE CASCADE,
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  module_id VARCHAR(100) NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  progress_percent NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  last_position_seconds INT NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_lesson_progress_bounds CHECK (progress_percent >= 0 AND progress_percent <= 100),
  CONSTRAINT chk_lesson_position_bounds CHECK (last_position_seconds >= 0),
  CONSTRAINT uq_student_enrollment_module UNIQUE (student_id, enrollment_id, module_id)
);

-- Compound Index for High-Performance Queries
CREATE INDEX IF NOT EXISTS idx_lesson_progress_student_enrollment ON public.lesson_progress(student_id, enrollment_id);

-- Enable Row Level Security (RLS)
ALTER TABLE public.lesson_progress ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Students can only SELECT their own lesson progress
DROP POLICY IF EXISTS lesson_progress_select_policy ON public.lesson_progress;
CREATE POLICY lesson_progress_select_policy ON public.lesson_progress
  FOR SELECT
  USING (
    student_id IN (
      SELECT id FROM public.students
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(auth.jwt() ->> 'email'))
    )
  );

-- RLS Policy: Students can only INSERT their own lesson progress
DROP POLICY IF EXISTS lesson_progress_insert_policy ON public.lesson_progress;
CREATE POLICY lesson_progress_insert_policy ON public.lesson_progress
  FOR INSERT
  WITH CHECK (
    student_id IN (
      SELECT id FROM public.students
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(auth.jwt() ->> 'email'))
    )
  );

-- RLS Policy: Students can only UPDATE their own lesson progress
DROP POLICY IF EXISTS lesson_progress_update_policy ON public.lesson_progress;
CREATE POLICY lesson_progress_update_policy ON public.lesson_progress
  FOR UPDATE
  USING (
    student_id IN (
      SELECT id FROM public.students
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(auth.jwt() ->> 'email'))
    )
  );
