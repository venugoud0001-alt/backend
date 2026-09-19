-- Speed up student curriculum enrichment: topics are filtered by course_id on every
-- GET /courses/:slug/curriculum. module_id was indexed; course_id was not.
CREATE INDEX IF NOT EXISTS idx_topics_course_id
  ON public.topics(course_id);

CREATE INDEX IF NOT EXISTS idx_topics_course_module
  ON public.topics(course_id, module_id);

-- Align lesson progress lookups with the scoped student+course reads in progress.service
CREATE INDEX IF NOT EXISTS idx_lesson_video_progress_student_course
  ON public.lesson_video_progress(student_id, course_id);

CREATE INDEX IF NOT EXISTS idx_topic_video_progress_student_course
  ON public.topic_video_progress(student_id, course_id);
