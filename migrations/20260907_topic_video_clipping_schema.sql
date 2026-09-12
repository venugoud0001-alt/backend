-- =========================================================================
-- INTERNNETRA LMS: TOPIC-BASED VIDEO PROCESSING & INPUT CLIPPING SCHEMA
-- Self-Contained Migration: Creates tables if missing and alters existing
-- =========================================================================

-- 1. CREATE MODULES TABLE (If not already created)
CREATE TABLE IF NOT EXISTS public.modules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  display_order INT DEFAULT 1,
  duration_minutes INT DEFAULT 0,
  video_url TEXT,
  video_status VARCHAR(50) DEFAULT 'NO_VIDEO',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. CREATE / EXTEND TOPICS TABLE
CREATE TABLE IF NOT EXISTS public.topics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  module_id VARCHAR(128),
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  display_order INT DEFAULT 1,
  
  -- Timecode boundaries (Canonical representation in seconds + formatted timecode)
  start_time_seconds NUMERIC(10, 3) DEFAULT 0.000,
  end_time_seconds NUMERIC(10, 3) DEFAULT 0.000,
  duration_seconds INT DEFAULT 0,
  start_timecode VARCHAR(20) DEFAULT '00:00:00:00',
  end_timecode VARCHAR(20) DEFAULT '00:00:00:00',
  
  -- S3 Source & MediaConvert References
  source_video_id UUID,
  mediaconvert_job_id VARCHAR(255),
  
  -- HLS Rendition S3 Keys and URLs
  hls_master_key TEXT,
  hls_720p_key TEXT,
  hls_1080p_key TEXT,
  hls_master_url TEXT,
  hls_720p_url TEXT,
  hls_1080p_url TEXT,
  hls_prefix TEXT,
  
  -- Processing Lifecycle & Status
  processing_status VARCHAR(50) DEFAULT 'DRAFT',
  processing_error TEXT,
  processing_started_at TIMESTAMPTZ,
  processing_completed_at TIMESTAMPTZ,
  is_published BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Safely ensure columns exist if topics table previously existed
DO $$
BEGIN
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS module_id VARCHAR(128);
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS start_time_seconds NUMERIC(10, 3) DEFAULT 0.000;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS end_time_seconds NUMERIC(10, 3) DEFAULT 0.000;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS duration_seconds INT DEFAULT 0;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS start_timecode VARCHAR(20) DEFAULT '00:00:00:00';
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS end_timecode VARCHAR(20) DEFAULT '00:00:00:00';
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS source_video_id UUID;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS mediaconvert_job_id VARCHAR(255);
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS hls_master_key TEXT;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS hls_720p_key TEXT;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS hls_1080p_key TEXT;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS hls_master_url TEXT;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS hls_720p_url TEXT;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS hls_1080p_url TEXT;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS hls_prefix TEXT;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS processing_status VARCHAR(50) DEFAULT 'DRAFT';
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS processing_error TEXT;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMPTZ;
  ALTER TABLE public.topics ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT TRUE;
END $$;

-- Status check constraint on topics table
ALTER TABLE public.topics DROP CONSTRAINT IF EXISTS chk_topic_processing_status;
ALTER TABLE public.topics ADD CONSTRAINT chk_topic_processing_status 
  CHECK (processing_status IN ('DRAFT', 'QUEUED', 'PROCESSING', 'READY', 'FAILED', 'DELETING', 'DELETED'));

-- Indices for topic lookups
CREATE INDEX IF NOT EXISTS idx_topics_module_id ON public.topics(module_id);
CREATE INDEX IF NOT EXISTS idx_topics_source_video ON public.topics(source_video_id);
CREATE INDEX IF NOT EXISTS idx_topics_processing_status ON public.topics(processing_status);
CREATE INDEX IF NOT EXISTS idx_topics_job_id ON public.topics(mediaconvert_job_id);

-- 3. DEDICATED TOPIC VIDEOS TABLE (SEPARATING TOPIC METADATA FROM MEDIA PROCESSING)
CREATE TABLE IF NOT EXISTS public.topic_videos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  topic_id UUID REFERENCES public.topics(id) ON DELETE CASCADE,
  module_id VARCHAR(128),
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  source_video_id UUID,
  
  -- Timecode Clipping Boundaries
  start_time_seconds NUMERIC(10, 3) NOT NULL DEFAULT 0.000,
  end_time_seconds NUMERIC(10, 3) NOT NULL DEFAULT 0.000,
  duration_seconds INT NOT NULL DEFAULT 0,
  start_timecode VARCHAR(20) NOT NULL DEFAULT '00:00:00:00',
  end_timecode VARCHAR(20) NOT NULL DEFAULT '00:00:00:00',
  
  -- AWS S3 & MediaConvert State
  source_s3_bucket VARCHAR(255),
  source_s3_key TEXT,
  mediaconvert_job_id VARCHAR(255),
  
  -- HLS Rendition S3 Keys and Playback Manifests
  hls_prefix TEXT,
  hls_master_key TEXT,
  hls_720p_key TEXT,
  hls_1080p_key TEXT,
  hls_master_url TEXT,
  hls_720p_url TEXT,
  hls_1080p_url TEXT,
  
  -- Processing Status
  status VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
  error_code VARCHAR(100),
  error_message TEXT,
  retry_count INT DEFAULT 0,
  
  -- Telemetry Timestamps
  queued_at TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  processing_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT chk_topic_video_status CHECK (status IN ('DRAFT', 'QUEUED', 'PROCESSING', 'READY', 'FAILED', 'DELETING', 'DELETED')),
  CONSTRAINT chk_topic_video_duration_non_negative CHECK (duration_seconds >= 0)
);

CREATE INDEX IF NOT EXISTS idx_topic_videos_topic_id ON public.topic_videos(topic_id);
CREATE INDEX IF NOT EXISTS idx_topic_videos_module_id ON public.topic_videos(module_id);
CREATE INDEX IF NOT EXISTS idx_topic_videos_status ON public.topic_videos(status);
CREATE INDEX IF NOT EXISTS idx_topic_videos_job_id ON public.topic_videos(mediaconvert_job_id);

-- 4. ENHANCE LESSON_VIDEOS FOR PARENT SOURCE BATCH TRACKING
DO $$
BEGIN
  ALTER TABLE public.lesson_videos ADD COLUMN IF NOT EXISTS source_duration_seconds NUMERIC(10, 3) DEFAULT 0.000;
  ALTER TABLE public.lesson_videos ADD COLUMN IF NOT EXISTS is_topic_split BOOLEAN DEFAULT FALSE;
  ALTER TABLE public.lesson_videos ADD COLUMN IF NOT EXISTS total_topics_count INT DEFAULT 0;
  ALTER TABLE public.lesson_videos ADD COLUMN IF NOT EXISTS ready_topics_count INT DEFAULT 0;
  ALTER TABLE public.lesson_videos ADD COLUMN IF NOT EXISTS failed_topics_count INT DEFAULT 0;
END $$;

-- 5. TOPIC-LEVEL STUDENT PROGRESS TELEMETRY
CREATE TABLE IF NOT EXISTS public.topic_video_progress (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  enrollment_id UUID REFERENCES public.enrollments(id) ON DELETE CASCADE,
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  module_id VARCHAR(128),
  topic_id UUID NOT NULL,
  
  -- Playhead & Progress Metrics
  watched_position_seconds INT NOT NULL DEFAULT 0,
  watched_duration_seconds INT NOT NULL DEFAULT 0,
  total_duration_seconds INT NOT NULL DEFAULT 0,
  completion_percent NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  is_completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  
  -- Activity Timestamps
  last_watched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT chk_topic_progress_bounds CHECK (completion_percent >= 0.00 AND completion_percent <= 100.00),
  CONSTRAINT chk_topic_position_non_negative CHECK (watched_position_seconds >= 0),
  CONSTRAINT uq_topic_progress_student_topic UNIQUE (student_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_topic_progress_student ON public.topic_video_progress(student_id);
CREATE INDEX IF NOT EXISTS idx_topic_progress_topic ON public.topic_video_progress(topic_id);
CREATE INDEX IF NOT EXISTS idx_topic_progress_module ON public.topic_video_progress(module_id);
CREATE INDEX IF NOT EXISTS idx_topic_progress_course ON public.topic_video_progress(course_id);
