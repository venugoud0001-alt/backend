-- =========================================================================
-- INTERNNETRA LMS: PHASE 1 VIDEO ANALYTICS DATABASE FOUNDATION
-- Supabase / Postgres Additive Migration
-- Migration: 20260909_video_analytics.sql
-- Strictly Additive — Preserves all existing video playback and streaming tables
-- =========================================================================

-- 1. VIDEO ANALYTICS EVENTS TABLE
CREATE TABLE IF NOT EXISTS public.video_analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_event_id UUID,
  student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  module_id TEXT,
  lesson_id TEXT,
  topic_id UUID REFERENCES public.topics(id) ON DELETE CASCADE,
  video_id UUID,
  session_id UUID,
  event_type TEXT NOT NULL,
  position_seconds NUMERIC(10, 3),
  duration_seconds NUMERIC(10, 3),
  completion_percentage NUMERIC(5, 2),
  event_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb,

  -- Safe bounds constraints (accommodates valid nulls for lifecycle events)
  CONSTRAINT chk_video_analytics_position CHECK (position_seconds IS NULL OR position_seconds >= 0),
  CONSTRAINT chk_video_analytics_duration CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  CONSTRAINT chk_video_analytics_completion CHECK (completion_percentage IS NULL OR (completion_percentage >= 0.00 AND completion_percentage <= 100.00)),
  CONSTRAINT chk_video_analytics_event_type CHECK (
    event_type IN (
      'VIDEO_TOPIC_OPENED',
      'VIDEO_SESSION_STARTED',
      'VIDEO_PLAY',
      'VIDEO_PAUSE',
      'VIDEO_SEEK',
      'VIDEO_HEARTBEAT',
      'VIDEO_COMPLETED',
      'VIDEO_SESSION_ENDED',
      'VIDEO_TOPIC_SWITCHED'
    )
  )
);

-- 2. CLIENT-SIDE EVENT DEDUPLICATION PROTECTION
-- Safe uniqueness: Prevents network retries from inserting duplicates while safely permitting NULLs
CREATE UNIQUE INDEX IF NOT EXISTS uq_video_analytics_client_event_id 
  ON public.video_analytics_events (client_event_id) 
  WHERE client_event_id IS NOT NULL;

-- 3. SINGLE-COLUMN INDEXES FOR ANALYTICAL LOOKUPS
CREATE INDEX IF NOT EXISTS idx_video_analytics_student_id 
  ON public.video_analytics_events (student_id);

CREATE INDEX IF NOT EXISTS idx_video_analytics_course_id 
  ON public.video_analytics_events (course_id);

CREATE INDEX IF NOT EXISTS idx_video_analytics_module_id 
  ON public.video_analytics_events (module_id);

CREATE INDEX IF NOT EXISTS idx_video_analytics_topic_id 
  ON public.video_analytics_events (topic_id);

CREATE INDEX IF NOT EXISTS idx_video_analytics_video_id 
  ON public.video_analytics_events (video_id);

CREATE INDEX IF NOT EXISTS idx_video_analytics_session_id 
  ON public.video_analytics_events (session_id);

CREATE INDEX IF NOT EXISTS idx_video_analytics_event_type 
  ON public.video_analytics_events (event_type);

CREATE INDEX IF NOT EXISTS idx_video_analytics_event_timestamp 
  ON public.video_analytics_events (event_timestamp DESC);

-- 4. COMPOSITE INDEXES FOR HIGH-TRAFFIC REPORTING QUERIES
CREATE INDEX IF NOT EXISTS idx_video_analytics_topic_timestamp 
  ON public.video_analytics_events (topic_id, event_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_video_analytics_course_timestamp 
  ON public.video_analytics_events (course_id, event_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_video_analytics_student_topic_timestamp 
  ON public.video_analytics_events (student_id, topic_id, event_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_video_analytics_session_timestamp 
  ON public.video_analytics_events (session_id, event_timestamp DESC);

-- 5. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.video_analytics_events ENABLE ROW LEVEL SECURITY;

-- 5.1 Students can INSERT their own events only
DROP POLICY IF EXISTS "Students insert own video analytics events" ON public.video_analytics_events;
CREATE POLICY "Students insert own video analytics events" ON public.video_analytics_events
  FOR INSERT
  WITH CHECK (
    auth.uid() = student_id 
    OR student_id IN (
      SELECT id FROM public.students 
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(auth.jwt() ->> 'email')) 
         OR id = auth.uid()
    )
  );

-- 5.2 Students can SELECT only their own video analytics events (zero visibility into others)
DROP POLICY IF EXISTS "Students select own video analytics events" ON public.video_analytics_events;
CREATE POLICY "Students select own video analytics events" ON public.video_analytics_events
  FOR SELECT
  USING (
    auth.uid() = student_id 
    OR student_id IN (
      SELECT id FROM public.students 
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(auth.jwt() ->> 'email')) 
         OR id = auth.uid()
    )
  );

-- 5.3 Administrative personnel can read all analytics events
DROP POLICY IF EXISTS "Admins select all video analytics events" ON public.video_analytics_events;
CREATE POLICY "Admins select all video analytics events" ON public.video_analytics_events
  FOR SELECT
  USING (
    auth.jwt() ->> 'email' IN (
      SELECT email FROM public.sub_users 
      WHERE status = 'Active' AND role IN ('ADMIN', 'SUPER_ADMIN')
    )
    OR auth.uid() IN (
      SELECT id FROM public.profiles 
      WHERE role IN ('ADMIN', 'SUPER_ADMIN')
    )
  );

-- 5.4 Backend service role bypasses RLS
DROP POLICY IF EXISTS "Service role full access on video analytics" ON public.video_analytics_events;
CREATE POLICY "Service role full access on video analytics" ON public.video_analytics_events
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

-- 6. SESSION AGGREGATION VIEW
-- Aggregates raw video analytics events into structured session telemetry
CREATE OR REPLACE VIEW public.video_session_aggregates AS
SELECT
  session_id,
  student_id,
  course_id,
  module_id,
  topic_id,
  MIN(event_timestamp) AS started_at,
  MAX(event_timestamp) AS ended_at,
  COUNT(*) FILTER (WHERE event_type = 'VIDEO_PLAY') AS play_count,
  COALESCE(
    SUM(
      CASE 
        WHEN event_type = 'VIDEO_HEARTBEAT' THEN 
          COALESCE((metadata->>'heartbeat_interval_seconds')::numeric, 15)
        ELSE 0 
      END
    ), 
    GREATEST(0, MAX(position_seconds) - MIN(position_seconds)),
    0
  ) AS watch_seconds,
  COALESCE(MAX(position_seconds), 0) AS max_position,
  COALESCE(BOOL_OR(event_type = 'VIDEO_COMPLETED'), FALSE) AS completed
FROM public.video_analytics_events
WHERE session_id IS NOT NULL
GROUP BY session_id, student_id, course_id, module_id, topic_id;

-- 7. TOPIC ANALYTICS VIEW
CREATE OR REPLACE VIEW public.video_topic_analytics AS
SELECT
  topic_id,
  course_id,
  module_id,
  COUNT(DISTINCT student_id) AS unique_viewers,
  COUNT(DISTINCT session_id) AS total_sessions,
  COUNT(*) FILTER (WHERE event_type = 'VIDEO_PLAY') AS total_plays,
  COUNT(DISTINCT student_id) FILTER (WHERE event_type = 'VIDEO_COMPLETED') AS total_completed_students,
  COALESCE(
    SUM(
      CASE 
        WHEN event_type = 'VIDEO_HEARTBEAT' THEN 
          COALESCE((metadata->>'heartbeat_interval_seconds')::numeric, 15)
        ELSE 0 
      END
    ), 
    0
  ) AS total_watch_seconds,
  ROUND(
    COALESCE(
      AVG(
        CASE 
          WHEN event_type = 'VIDEO_HEARTBEAT' THEN 
            COALESCE((metadata->>'heartbeat_interval_seconds')::numeric, 15)
          ELSE NULL 
        END
      ), 
      0
    ),
    2
  ) AS avg_watch_seconds,
  ROUND(COALESCE(AVG(completion_percentage), 0), 2) AS avg_completion_percentage,
  MIN(event_timestamp) AS first_viewed_at,
  MAX(event_timestamp) AS last_viewed_at
FROM public.video_analytics_events
WHERE topic_id IS NOT NULL
GROUP BY topic_id, course_id, module_id;

-- 8. STUDENT ANALYTICS VIEW
CREATE OR REPLACE VIEW public.video_student_analytics AS
SELECT
  student_id,
  COUNT(DISTINCT course_id) AS courses_engaged,
  COUNT(DISTINCT topic_id) AS topics_viewed,
  COUNT(DISTINCT session_id) AS total_sessions,
  COUNT(*) FILTER (WHERE event_type = 'VIDEO_PLAY') AS total_plays,
  COUNT(DISTINCT topic_id) FILTER (WHERE event_type = 'VIDEO_COMPLETED') AS topics_completed,
  COALESCE(
    SUM(
      CASE 
        WHEN event_type = 'VIDEO_HEARTBEAT' THEN 
          COALESCE((metadata->>'heartbeat_interval_seconds')::numeric, 15)
        ELSE 0 
      END
    ), 
    0
  ) AS total_watch_seconds,
  ROUND(
    COALESCE(
      AVG(
        CASE 
          WHEN event_type = 'VIDEO_HEARTBEAT' THEN 
            COALESCE((metadata->>'heartbeat_interval_seconds')::numeric, 15)
          ELSE NULL 
        END
      ), 
      0
    ),
    2
  ) AS avg_watch_seconds,
  ROUND(COALESCE(AVG(completion_percentage), 0), 2) AS avg_completion_percentage,
  MIN(event_timestamp) AS first_active_at,
  MAX(event_timestamp) AS last_active_at
FROM public.video_analytics_events
WHERE student_id IS NOT NULL
GROUP BY student_id;

-- 9. COURSE ANALYTICS VIEW
CREATE OR REPLACE VIEW public.video_course_analytics AS
SELECT
  course_id,
  COUNT(DISTINCT student_id) AS unique_viewers,
  COUNT(DISTINCT topic_id) AS active_topics_count,
  COUNT(DISTINCT session_id) AS total_sessions,
  COUNT(*) FILTER (WHERE event_type = 'VIDEO_PLAY') AS total_plays,
  COUNT(DISTINCT student_id) FILTER (WHERE event_type = 'VIDEO_COMPLETED') AS total_completed_students,
  COALESCE(
    SUM(
      CASE 
        WHEN event_type = 'VIDEO_HEARTBEAT' THEN 
          COALESCE((metadata->>'heartbeat_interval_seconds')::numeric, 15)
        ELSE 0 
      END
    ), 
    0
  ) AS total_watch_seconds,
  ROUND(
    COALESCE(
      AVG(
        CASE 
          WHEN event_type = 'VIDEO_HEARTBEAT' THEN 
            COALESCE((metadata->>'heartbeat_interval_seconds')::numeric, 15)
          ELSE NULL 
        END
      ), 
      0
    ),
    2
  ) AS avg_watch_seconds,
  ROUND(COALESCE(AVG(completion_percentage), 0), 2) AS avg_completion_percentage,
  MIN(event_timestamp) AS first_viewed_at,
  MAX(event_timestamp) AS last_viewed_at
FROM public.video_analytics_events
WHERE course_id IS NOT NULL
GROUP BY course_id;

-- 10. MODULE ANALYTICS VIEW
CREATE OR REPLACE VIEW public.video_module_analytics AS
SELECT
  course_id,
  module_id,
  COUNT(DISTINCT student_id) AS unique_viewers,
  COUNT(DISTINCT topic_id) AS active_topics_count,
  COUNT(DISTINCT session_id) AS total_sessions,
  COUNT(*) FILTER (WHERE event_type = 'VIDEO_PLAY') AS total_plays,
  COUNT(DISTINCT student_id) FILTER (WHERE event_type = 'VIDEO_COMPLETED') AS total_completed_students,
  COALESCE(
    SUM(
      CASE 
        WHEN event_type = 'VIDEO_HEARTBEAT' THEN 
          COALESCE((metadata->>'heartbeat_interval_seconds')::numeric, 15)
        ELSE 0 
      END
    ), 
    0
  ) AS total_watch_seconds,
  ROUND(
    COALESCE(
      AVG(
        CASE 
          WHEN event_type = 'VIDEO_HEARTBEAT' THEN 
            COALESCE((metadata->>'heartbeat_interval_seconds')::numeric, 15)
          ELSE NULL 
        END
      ), 
      0
    ),
    2
  ) AS avg_watch_seconds,
  ROUND(COALESCE(AVG(completion_percentage), 0), 2) AS avg_completion_percentage,
  MIN(event_timestamp) AS first_viewed_at,
  MAX(event_timestamp) AS last_viewed_at
FROM public.video_analytics_events
WHERE module_id IS NOT NULL
GROUP BY course_id, module_id;

-- 11. PARAMETERIZED ANALYTICS FUNCTIONS WITH DATE FILTERING
-- 11.1 Topic-level Analytics by Date Range
CREATE OR REPLACE FUNCTION public.fn_get_topic_analytics(
  p_topic_id UUID,
  p_start_date TIMESTAMPTZ DEFAULT '-infinity'::timestamptz,
  p_end_date TIMESTAMPTZ DEFAULT 'infinity'::timestamptz
)
RETURNS TABLE (
  topic_id UUID,
  course_id UUID,
  module_id TEXT,
  unique_viewers BIGINT,
  total_sessions BIGINT,
  total_plays BIGINT,
  total_completed_students BIGINT,
  total_watch_seconds NUMERIC,
  avg_watch_seconds NUMERIC,
  avg_completion_percentage NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.topic_id,
    e.course_id,
    e.module_id,
    COUNT(DISTINCT e.student_id) AS unique_viewers,
    COUNT(DISTINCT e.session_id) AS total_sessions,
    COUNT(*) FILTER (WHERE e.event_type = 'VIDEO_PLAY') AS total_plays,
    COUNT(DISTINCT e.student_id) FILTER (WHERE e.event_type = 'VIDEO_COMPLETED') AS total_completed_students,
    COALESCE(
      SUM(
        CASE 
          WHEN e.event_type = 'VIDEO_HEARTBEAT' THEN 
            COALESCE((e.metadata->>'heartbeat_interval_seconds')::numeric, 15)
          ELSE 0 
        END
      ), 
      0
    ) AS total_watch_seconds,
    ROUND(
      COALESCE(
        AVG(
          CASE 
            WHEN e.event_type = 'VIDEO_HEARTBEAT' THEN 
              COALESCE((e.metadata->>'heartbeat_interval_seconds')::numeric, 15)
            ELSE NULL 
          END
        ), 
        0
      ), 
      2
    ) AS avg_watch_seconds,
    ROUND(COALESCE(AVG(e.completion_percentage), 0), 2) AS avg_completion_percentage
  FROM public.video_analytics_events e
  WHERE e.topic_id = p_topic_id
    AND e.event_timestamp >= p_start_date
    AND e.event_timestamp <= p_end_date
  GROUP BY e.topic_id, e.course_id, e.module_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- 11.2 Course-level Analytics by Date Range
CREATE OR REPLACE FUNCTION public.fn_get_course_analytics(
  p_course_id UUID,
  p_start_date TIMESTAMPTZ DEFAULT '-infinity'::timestamptz,
  p_end_date TIMESTAMPTZ DEFAULT 'infinity'::timestamptz
)
RETURNS TABLE (
  course_id UUID,
  unique_viewers BIGINT,
  active_topics_count BIGINT,
  total_sessions BIGINT,
  total_plays BIGINT,
  total_completed_students BIGINT,
  total_watch_seconds NUMERIC,
  avg_watch_seconds NUMERIC,
  avg_completion_percentage NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.course_id,
    COUNT(DISTINCT e.student_id) AS unique_viewers,
    COUNT(DISTINCT e.topic_id) AS active_topics_count,
    COUNT(DISTINCT e.session_id) AS total_sessions,
    COUNT(*) FILTER (WHERE e.event_type = 'VIDEO_PLAY') AS total_plays,
    COUNT(DISTINCT e.student_id) FILTER (WHERE e.event_type = 'VIDEO_COMPLETED') AS total_completed_students,
    COALESCE(
      SUM(
        CASE 
          WHEN e.event_type = 'VIDEO_HEARTBEAT' THEN 
            COALESCE((e.metadata->>'heartbeat_interval_seconds')::numeric, 15)
          ELSE 0 
        END
      ), 
      0
    ) AS total_watch_seconds,
    ROUND(
      COALESCE(
        AVG(
          CASE 
            WHEN e.event_type = 'VIDEO_HEARTBEAT' THEN 
              COALESCE((e.metadata->>'heartbeat_interval_seconds')::numeric, 15)
            ELSE NULL 
          END
        ), 
        0
      ), 
      2
    ) AS avg_watch_seconds,
    ROUND(COALESCE(AVG(e.completion_percentage), 0), 2) AS avg_completion_percentage
  FROM public.video_analytics_events e
  WHERE e.course_id = p_course_id
    AND e.event_timestamp >= p_start_date
    AND e.event_timestamp <= p_end_date
  GROUP BY e.course_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- 11.3 Student-level Analytics by Date Range
CREATE OR REPLACE FUNCTION public.fn_get_student_analytics(
  p_student_id UUID,
  p_start_date TIMESTAMPTZ DEFAULT '-infinity'::timestamptz,
  p_end_date TIMESTAMPTZ DEFAULT 'infinity'::timestamptz
)
RETURNS TABLE (
  student_id UUID,
  courses_engaged BIGINT,
  topics_viewed BIGINT,
  total_sessions BIGINT,
  total_plays BIGINT,
  topics_completed BIGINT,
  total_watch_seconds NUMERIC,
  avg_watch_seconds NUMERIC,
  avg_completion_percentage NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.student_id,
    COUNT(DISTINCT e.course_id) AS courses_engaged,
    COUNT(DISTINCT e.topic_id) AS topics_viewed,
    COUNT(DISTINCT e.session_id) AS total_sessions,
    COUNT(*) FILTER (WHERE e.event_type = 'VIDEO_PLAY') AS total_plays,
    COUNT(DISTINCT e.topic_id) FILTER (WHERE e.event_type = 'VIDEO_COMPLETED') AS topics_completed,
    COALESCE(
      SUM(
        CASE 
          WHEN e.event_type = 'VIDEO_HEARTBEAT' THEN 
            COALESCE((e.metadata->>'heartbeat_interval_seconds')::numeric, 15)
          ELSE 0 
        END
      ), 
      0
    ) AS total_watch_seconds,
    ROUND(
      COALESCE(
        AVG(
          CASE 
            WHEN e.event_type = 'VIDEO_HEARTBEAT' THEN 
              COALESCE((e.metadata->>'heartbeat_interval_seconds')::numeric, 15)
            ELSE NULL 
          END
        ), 
        0
      ), 
      2
    ) AS avg_watch_seconds,
    ROUND(COALESCE(AVG(e.completion_percentage), 0), 2) AS avg_completion_percentage
  FROM public.video_analytics_events e
  WHERE e.student_id = p_student_id
    AND e.event_timestamp >= p_start_date
    AND e.event_timestamp <= p_end_date
  GROUP BY e.student_id;
END;
$$ LANGUAGE plpgsql STABLE;
