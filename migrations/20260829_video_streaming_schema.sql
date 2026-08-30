-- =========================================================================
-- INTERNNETRA LMS PHASE 1: VIDEO DATA MODEL & STREAMING ARCHITECTURE
-- Tables: lesson_videos (Video Metadata & Transcoding Lifecycle)
--         lesson_video_progress (Student Playback & Watch Telemetry)
-- =========================================================================

-- 1. VIDEO PROCESSING ENUM / STATUS CONSTRAINT
-- Processing States:
--   - 'UPLOADING': Direct client-to-S3 presigned multipart upload in progress
--   - 'UPLOADED': File upload confirmed in S3 source bucket
--   - 'PROCESSING': AWS MediaConvert transcoding job initiated for 720p/1080p HLS
--   - 'READY': HLS transcoding completed, verified, and ready for CloudFront streaming
--   - 'FAILED': Transcoding or verification failed (failure details in error_message)

-- 2. LESSON VIDEOS TABLE (METADATA ONLY - NO BINARY DATA)
CREATE TABLE IF NOT EXISTS public.lesson_videos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lesson_id VARCHAR(100) NOT NULL,
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  module_id VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'UPLOADING',
  
  -- AWS S3 Source (Temporary - Deleted upon transcode verification)
  source_s3_bucket VARCHAR(255),
  source_s3_key TEXT,
  source_deleted_at TIMESTAMPTZ,
  
  -- AWS MediaConvert Transcoding Lifecycle
  mediaconvert_job_id VARCHAR(255),
  
  -- HLS Rendition Outputs (720p & 1080p only)
  hls_master_url TEXT,
  hls_720p_url TEXT,
  hls_1080p_url TEXT,
  
  -- Video Metadata
  duration_seconds INT DEFAULT 0,
  file_size_bytes BIGINT DEFAULT 0,
  thumbnail_url TEXT,
  
  -- Failure Tracking
  error_code VARCHAR(100),
  error_message TEXT,
  
  -- Availability State
  is_published BOOLEAN DEFAULT TRUE,
  
  -- Lifecycle Timestamps
  upload_started_at TIMESTAMPTZ DEFAULT NOW(),
  upload_completed_at TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  processing_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT chk_video_status CHECK (status IN ('UPLOADING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED')),
  CONSTRAINT chk_video_duration_non_negative CHECK (duration_seconds >= 0)
);

-- Indices for Fast Lookups
CREATE INDEX IF NOT EXISTS idx_lesson_videos_lesson_id ON public.lesson_videos(lesson_id);
CREATE INDEX IF NOT EXISTS idx_lesson_videos_course_id ON public.lesson_videos(course_id);
CREATE INDEX IF NOT EXISTS idx_lesson_videos_status ON public.lesson_videos(status);
CREATE INDEX IF NOT EXISTS idx_lesson_videos_job_id ON public.lesson_videos(mediaconvert_job_id);

-- 3. STUDENT VIDEO PROGRESS TABLE (WATCH POSITION & COMPLETION TELEMETRY)
CREATE TABLE IF NOT EXISTS public.lesson_video_progress (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  enrollment_id UUID REFERENCES public.enrollments(id) ON DELETE CASCADE,
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  lesson_id VARCHAR(100) NOT NULL,
  module_id VARCHAR(100),
  
  -- Playhead & Watch Time Metrics
  watched_position_seconds INT NOT NULL DEFAULT 0,
  watched_duration_seconds INT NOT NULL DEFAULT 0,
  total_duration_seconds INT NOT NULL DEFAULT 0,
  
  -- Completion Metrics
  completion_percent NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  is_completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  
  -- Timestamps
  last_watched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT chk_progress_bounds CHECK (completion_percent >= 0.00 AND completion_percent <= 100.00),
  CONSTRAINT chk_position_non_negative CHECK (watched_position_seconds >= 0),
  CONSTRAINT chk_watched_duration_non_negative CHECK (watched_duration_seconds >= 0),
  CONSTRAINT uq_video_progress_student_lesson UNIQUE (student_id, lesson_id)
);

-- Indices for Progress Queries
CREATE INDEX IF NOT EXISTS idx_video_progress_student_enrollment ON public.lesson_video_progress(student_id, enrollment_id);
CREATE INDEX IF NOT EXISTS idx_video_progress_lesson ON public.lesson_video_progress(lesson_id);
CREATE INDEX IF NOT EXISTS idx_video_progress_student_course ON public.lesson_video_progress(student_id, course_id);

-- 4. SAFE COMPATIBILITY COLUMN ENHANCEMENTS ON EXISTING TABLES (IF THEY EXIST)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'lessons') THEN
    ALTER TABLE public.lessons ADD COLUMN IF NOT EXISTS transcode_status VARCHAR(50) DEFAULT 'READY';
    ALTER TABLE public.lessons ADD COLUMN IF NOT EXISTS hls_master_url TEXT;
    ALTER TABLE public.lessons ADD COLUMN IF NOT EXISTS hls_720p_url TEXT;
    ALTER TABLE public.lessons ADD COLUMN IF NOT EXISTS hls_1080p_url TEXT;
    ALTER TABLE public.lessons ADD COLUMN IF NOT EXISTS mediaconvert_job_id VARCHAR(255);
    ALTER TABLE public.lessons ADD COLUMN IF NOT EXISTS failure_reason TEXT;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'lesson_progress') THEN
    ALTER TABLE public.lesson_progress ADD COLUMN IF NOT EXISTS watched_duration_seconds INT DEFAULT 0;
    ALTER TABLE public.lesson_progress ADD COLUMN IF NOT EXISTS total_duration_seconds INT DEFAULT 0;
  END IF;
END $$;
