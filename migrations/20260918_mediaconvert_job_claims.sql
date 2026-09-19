-- =========================================================================
-- MediaConvert cost control: atomic job claims + CreateJob audit trail
-- Prevents duplicate CreateJob across Mode 1 (full module), Mode 2 (direct
-- topic), and topic clipping without collapsing those workflows together.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.mediaconvert_job_claims (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  processing_identity TEXT NOT NULL,
  processing_profile TEXT NOT NULL
    CHECK (processing_profile IN ('FULL_MODULE_HLS', 'DIRECT_TOPIC_HLS', 'TOPIC_CLIPPING')),
  processing_version TEXT NOT NULL DEFAULT 'v1',
  claim_status TEXT NOT NULL DEFAULT 'CLAIMED'
    CHECK (claim_status IN ('CLAIMED', 'SUBMITTED', 'READY', 'FAILED', 'RELEASED')),
  claim_owner_token TEXT NOT NULL,
  video_id UUID,
  upload_id TEXT,
  course_id UUID,
  module_id TEXT,
  topic_id TEXT,
  source_key TEXT,
  mediaconvert_job_id VARCHAR(255),
  trigger_source TEXT,
  environment TEXT,
  source_duration_seconds NUMERIC,
  source_width INT,
  source_height INT,
  requested_outputs TEXT[] DEFAULT '{}',
  error_message TEXT,
  claimed_at TIMESTAMPTZ DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Only one active claim per processing identity (QUEUED/PROCESSING equivalent)
CREATE UNIQUE INDEX IF NOT EXISTS uq_mc_claim_active_identity
  ON public.mediaconvert_job_claims (processing_identity)
  WHERE claim_status IN ('CLAIMED', 'SUBMITTED');

CREATE INDEX IF NOT EXISTS idx_mc_claims_job_id
  ON public.mediaconvert_job_claims (mediaconvert_job_id);

CREATE INDEX IF NOT EXISTS idx_mc_claims_video_id
  ON public.mediaconvert_job_claims (video_id);

CREATE INDEX IF NOT EXISTS idx_mc_claims_topic_id
  ON public.mediaconvert_job_claims (topic_id);

CREATE INDEX IF NOT EXISTS idx_mc_claims_created_at
  ON public.mediaconvert_job_claims (created_at DESC);

-- Immutable-ish audit log for every CreateJob (and blocked duplicates)
CREATE TABLE IF NOT EXISTS public.mediaconvert_job_audit (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type TEXT NOT NULL,
  video_id UUID,
  upload_id TEXT,
  course_id UUID,
  module_id TEXT,
  topic_id TEXT,
  processing_identity TEXT,
  processing_profile TEXT,
  processing_version TEXT,
  source_duration_seconds NUMERIC,
  source_width INT,
  source_height INT,
  requested_outputs TEXT[] DEFAULT '{}',
  environment TEXT,
  trigger_source TEXT,
  mediaconvert_job_id VARCHAR(255),
  existing_job_id VARCHAR(255),
  claim_id UUID REFERENCES public.mediaconvert_job_claims(id) ON DELETE SET NULL,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mc_audit_created_at
  ON public.mediaconvert_job_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mc_audit_event_type
  ON public.mediaconvert_job_audit (event_type);

CREATE INDEX IF NOT EXISTS idx_mc_audit_job_id
  ON public.mediaconvert_job_audit (mediaconvert_job_id);

CREATE INDEX IF NOT EXISTS idx_mc_audit_identity
  ON public.mediaconvert_job_audit (processing_identity);

-- Topic row claim token for queue race protection
ALTER TABLE public.topics
  ADD COLUMN IF NOT EXISTS processing_claim_token TEXT,
  ADD COLUMN IF NOT EXISTS processing_identity TEXT,
  ADD COLUMN IF NOT EXISTS processing_profile TEXT,
  ADD COLUMN IF NOT EXISTS processing_version TEXT;

ALTER TABLE public.lesson_videos
  ADD COLUMN IF NOT EXISTS processing_claim_token TEXT,
  ADD COLUMN IF NOT EXISTS processing_identity TEXT,
  ADD COLUMN IF NOT EXISTS processing_profile TEXT,
  ADD COLUMN IF NOT EXISTS processing_version TEXT,
  ADD COLUMN IF NOT EXISTS source_width INT,
  ADD COLUMN IF NOT EXISTS source_height INT,
  ADD COLUMN IF NOT EXISTS source_fps NUMERIC;

CREATE INDEX IF NOT EXISTS idx_topics_processing_identity
  ON public.topics (processing_identity);

CREATE INDEX IF NOT EXISTS idx_lesson_videos_processing_identity
  ON public.lesson_videos (processing_identity);
