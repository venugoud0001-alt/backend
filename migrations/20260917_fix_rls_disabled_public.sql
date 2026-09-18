-- =========================================================================
-- InternNetra: Fix Supabase "rls_disabled_in_public" WITHOUT breaking the app
-- Run this in: Supabase Dashboard → SQL Editor → New query → Run
-- Project: uvetznwcnsezyuxgjoou
--
-- What this does:
-- 1) Enables RLS on every public table (clears the security email)
-- 2) Keeps public catalog readable (courses, departments, pricing, curriculum)
-- 3) Lets logged-in students access ONLY their own rows
-- 4) Lets logged-in admins (rows in sub_users) manage admin tables
-- 5) Express backend using SUPABASE_SERVICE_ROLE_KEY still bypasses RLS
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER so policies can check admin/student safely)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  jwt_email text := LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')));
  ok boolean := false;
BEGIN
  IF jwt_email <> '' AND to_regclass('public.sub_users') IS NOT NULL THEN
    EXECUTE $q$
      SELECT EXISTS (
        SELECT 1 FROM public.sub_users su
        WHERE LOWER(TRIM(su.email)) = $1
          AND COALESCE(UPPER(su.status::text), 'ACTIVE') IN ('ACTIVE', 'ENABLED', 'TRUE')
      )
    $q$ INTO ok USING jwt_email;
    IF ok THEN RETURN true; END IF;
  END IF;

  IF auth.uid() IS NOT NULL AND to_regclass('public.profiles') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'role'
    ) THEN
      EXECUTE $q$
        SELECT EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = $1 AND LOWER(COALESCE(p.role::text, '')) IN ('admin', 'super_admin', 'owner')
        )
      $q$ INTO ok USING auth.uid();
      IF ok THEN RETURN true; END IF;
    END IF;
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_student_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id
  FROM public.students s
  WHERE LOWER(TRIM(s.email)) = LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')))
     OR s.id = auth.uid();
$$;

-- -------------------------------------------------------------------------
-- 1) Enable RLS on ALL public base tables (fixes rls_disabled_in_public)
-- -------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r' -- ordinary tables only
      AND c.relname NOT LIKE 'pg_%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
  END LOOP;
END $$;

-- -------------------------------------------------------------------------
-- 2) Drop dangerously open "USING (true)" policies (they keep data public)
-- -------------------------------------------------------------------------
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        qual = 'true'
        OR with_check = 'true'
        OR policyname ILIKE 'service_role%'
      )
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      pol.policyname, pol.schemaname, pol.tablename
    );
  END LOOP;
END $$;

-- =========================================================================
-- 3) CATALOG / PUBLIC READ (unauthenticated site + app catalog)
-- =========================================================================

-- COURSES
DROP POLICY IF EXISTS "Public can view published courses" ON public.courses;
CREATE POLICY "Public can view published courses" ON public.courses
  FOR SELECT TO anon, authenticated
  USING (COALESCE(status, 'PUBLISHED') IN ('PUBLISHED', 'ACTIVE'));

DROP POLICY IF EXISTS "Admins manage courses" ON public.courses;
CREATE POLICY "Admins manage courses" ON public.courses
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- DEPARTMENTS (if table exists)
DO $$ BEGIN
  IF to_regclass('public.departments') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Public can view departments" ON public.departments';
    EXECUTE $p$
      CREATE POLICY "Public can view departments" ON public.departments
        FOR SELECT TO anon, authenticated USING (true)
    $p$;
    EXECUTE 'DROP POLICY IF EXISTS "Admins manage departments" ON public.departments';
    EXECUTE $p$
      CREATE POLICY "Admins manage departments" ON public.departments
        FOR ALL TO authenticated
        USING (public.is_admin()) WITH CHECK (public.is_admin())
    $p$;
  END IF;
END $$;

-- BATCHES
DROP POLICY IF EXISTS "Public can view active batches" ON public.batches;
CREATE POLICY "Public can view active batches" ON public.batches
  FOR SELECT TO anon, authenticated
  USING (COALESCE(status, 'ACTIVE') IN ('ACTIVE', 'FULL', 'OPEN'));

DROP POLICY IF EXISTS "Admins manage batches" ON public.batches;
CREATE POLICY "Admins manage batches" ON public.batches
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Curriculum / pricing public read helpers
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'modules', 'lessons', 'topics', 'lesson_topics',
    'pricing_plans', 'installments', 'coupons',
    'course_versions', 'lesson_videos', 'topic_videos'
  ]
  LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Public can read ' || t, t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (true)',
        'Public can read ' || t, t
      );
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Admins manage ' || t, t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())',
        'Admins manage ' || t, t
      );
    END IF;
  END LOOP;
END $$;

-- SITE SETTINGS (payment page / WhatsApp links read this publicly)
DO $$ BEGIN
  IF to_regclass('public.site_settings') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Public can read site_settings" ON public.site_settings';
    EXECUTE $p$
      CREATE POLICY "Public can read site_settings" ON public.site_settings
        FOR SELECT TO anon, authenticated USING (true)
    $p$;
    EXECUTE 'DROP POLICY IF EXISTS "Admins manage site_settings" ON public.site_settings';
    EXECUTE $p$
      CREATE POLICY "Admins manage site_settings" ON public.site_settings
        FOR ALL TO authenticated
        USING (public.is_admin()) WITH CHECK (public.is_admin())
    $p$;
  END IF;
END $$;

-- =========================================================================
-- 4) STUDENT / AUTH OWN-DATA POLICIES
-- =========================================================================

-- PROFILES
DROP POLICY IF EXISTS "Users view own profile" ON public.profiles;
CREATE POLICY "Users view own profile" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.is_admin());

DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
CREATE POLICY "Users update own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id OR public.is_admin())
  WITH CHECK (auth.uid() = id OR public.is_admin());

DROP POLICY IF EXISTS "Users insert own profile" ON public.profiles;
CREATE POLICY "Users insert own profile" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id OR public.is_admin());

DROP POLICY IF EXISTS "Admins manage profiles" ON public.profiles;
CREATE POLICY "Admins manage profiles" ON public.profiles
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- STUDENTS
DROP POLICY IF EXISTS "Students view own record" ON public.students;
CREATE POLICY "Students view own record" ON public.students
  FOR SELECT TO authenticated
  USING (
    LOWER(TRIM(email)) = LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')))
    OR id = auth.uid()
    OR public.is_admin()
  );

DROP POLICY IF EXISTS "Students update own record" ON public.students;
CREATE POLICY "Students update own record" ON public.students
  FOR UPDATE TO authenticated
  USING (
    LOWER(TRIM(email)) = LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')))
    OR id = auth.uid()
    OR public.is_admin()
  )
  WITH CHECK (
    LOWER(TRIM(email)) = LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')))
    OR id = auth.uid()
    OR public.is_admin()
  );

DROP POLICY IF EXISTS "Admins manage students" ON public.students;
CREATE POLICY "Admins manage students" ON public.students
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ENROLLMENTS
DO $$ BEGIN
  IF to_regclass('public.enrollments') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Students view own enrollments" ON public.enrollments';
    EXECUTE 'DROP POLICY IF EXISTS "Students update own enrollments progress" ON public.enrollments';
    EXECUTE 'DROP POLICY IF EXISTS "Admins manage enrollments" ON public.enrollments';

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'enrollments' AND column_name = 'student_id'
    ) THEN
      EXECUTE $p$
        CREATE POLICY "Students view own enrollments" ON public.enrollments
          FOR SELECT TO authenticated
          USING (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())
      $p$;
      EXECUTE $p$
        CREATE POLICY "Students update own enrollments progress" ON public.enrollments
          FOR UPDATE TO authenticated
          USING (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())
          WITH CHECK (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())
      $p$;
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'enrollments' AND column_name = 'email'
    ) THEN
      EXECUTE $p$
        CREATE POLICY "Students view own enrollments" ON public.enrollments
          FOR SELECT TO authenticated
          USING (
            LOWER(TRIM(email)) = LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')))
            OR public.is_admin()
          )
      $p$;
    END IF;

    EXECUTE $p$
      CREATE POLICY "Admins manage enrollments" ON public.enrollments
        FOR ALL TO authenticated
        USING (public.is_admin())
        WITH CHECK (public.is_admin())
    $p$;
  END IF;
END $$;

-- PAYMENTS (production may only have email, not student_id)
DO $$ BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Students view own payments" ON public.payments';
    EXECUTE 'DROP POLICY IF EXISTS "Admins manage payments" ON public.payments';

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'student_id'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'email'
    ) THEN
      EXECUTE $p$
        CREATE POLICY "Students view own payments" ON public.payments
          FOR SELECT TO authenticated
          USING (
            (email IS NOT NULL AND LOWER(TRIM(email)) = LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', ''))))
            OR student_id IN (SELECT public.current_student_ids())
            OR public.is_admin()
          )
      $p$;
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'email'
    ) THEN
      EXECUTE $p$
        CREATE POLICY "Students view own payments" ON public.payments
          FOR SELECT TO authenticated
          USING (
            (email IS NOT NULL AND LOWER(TRIM(email)) = LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', ''))))
            OR public.is_admin()
          )
      $p$;
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'student_id'
    ) THEN
      EXECUTE $p$
        CREATE POLICY "Students view own payments" ON public.payments
          FOR SELECT TO authenticated
          USING (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())
      $p$;
    END IF;

    EXECUTE $p$
      CREATE POLICY "Admins manage payments" ON public.payments
        FOR ALL TO authenticated
        USING (public.is_admin())
        WITH CHECK (public.is_admin())
    $p$;
  END IF;
END $$;

-- ORDERS
DO $$ BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Students view own orders" ON public.orders';
    EXECUTE 'DROP POLICY IF EXISTS "Admins manage orders" ON public.orders';

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'student_id'
    ) THEN
      EXECUTE $p$
        CREATE POLICY "Students view own orders" ON public.orders
          FOR SELECT TO authenticated
          USING (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())
      $p$;
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'email'
    ) THEN
      EXECUTE $p$
        CREATE POLICY "Students view own orders" ON public.orders
          FOR SELECT TO authenticated
          USING (
            LOWER(TRIM(email)) = LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')))
            OR public.is_admin()
          )
      $p$;
    END IF;

    EXECUTE $p$
      CREATE POLICY "Admins manage orders" ON public.orders
        FOR ALL TO authenticated
        USING (public.is_admin())
        WITH CHECK (public.is_admin())
    $p$;
  END IF;
END $$;

-- LESSON / TOPIC PROGRESS
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'lesson_progress', 'lesson_video_progress', 'topic_video_progress'
  ]
  LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_own', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_own', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_admin', t);
      EXECUTE format('DROP POLICY IF EXISTS lesson_progress_select_policy ON public.%I', t);
      EXECUTE format('DROP POLICY IF EXISTS lesson_progress_insert_policy ON public.%I', t);
      EXECUTE format('DROP POLICY IF EXISTS lesson_progress_update_policy ON public.%I', t);

      -- Own-row access when student_id column exists
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = t AND column_name = 'student_id'
      ) THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())',
          t || '_select_own', t
        );
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())',
          t || '_insert_own', t
        );
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (student_id IN (SELECT public.current_student_ids()) OR public.is_admin()) WITH CHECK (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())',
          t || '_update_own', t
        );
      END IF;

      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())',
        t || '_admin', t
      );
    END IF;
  END LOOP;
END $$;

-- =========================================================================
-- 5) ADMIN / RBAC TABLES (sub_users used by AuthContext + Admin panel)
-- =========================================================================

-- SUB_USERS: allow a user to read their own admin row (login), admins manage all
DO $$ BEGIN
  IF to_regclass('public.sub_users') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Users read own sub_user" ON public.sub_users';
    EXECUTE $p$
      CREATE POLICY "Users read own sub_user" ON public.sub_users
        FOR SELECT TO authenticated
        USING (
          LOWER(TRIM(email)) = LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')))
          OR public.is_admin()
        )
    $p$;
    EXECUTE 'DROP POLICY IF EXISTS "Admins manage sub_users" ON public.sub_users';
    EXECUTE $p$
      CREATE POLICY "Admins manage sub_users" ON public.sub_users
        FOR ALL TO authenticated
        USING (public.is_admin())
        WITH CHECK (public.is_admin())
    $p$;
  END IF;
END $$;

-- roles / permissions / audit_logs: admin only (backend service_role bypasses)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles', 'permissions', 'audit_logs', 'certificate_requests', 'otp_verifications', 'installment_reminders', 'video_analytics_events']
  LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Admins manage ' || t, t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())',
        'Admins manage ' || t, t
      );
    END IF;
  END LOOP;
END $$;

-- OTP: allow authenticated user to read their own OTP row by email if column exists
DO $$ BEGIN
  IF to_regclass('public.otp_verifications') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='otp_verifications' AND column_name='email'
     ) THEN
    EXECUTE 'DROP POLICY IF EXISTS "Users read own otp" ON public.otp_verifications';
    EXECUTE $p$
      CREATE POLICY "Users read own otp" ON public.otp_verifications
        FOR SELECT TO authenticated
        USING (LOWER(TRIM(email)) = LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', ''))) OR public.is_admin())
    $p$;
  END IF;
END $$;

-- Certificate requests: student can see own
DO $$ BEGIN
  IF to_regclass('public.certificate_requests') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='certificate_requests' AND column_name='student_id'
     ) THEN
    EXECUTE 'DROP POLICY IF EXISTS "Students view own certificates" ON public.certificate_requests';
    EXECUTE $p$
      CREATE POLICY "Students view own certificates" ON public.certificate_requests
        FOR SELECT TO authenticated
        USING (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())
    $p$;
    EXECUTE 'DROP POLICY IF EXISTS "Students insert own certificates" ON public.certificate_requests';
    EXECUTE $p$
      CREATE POLICY "Students insert own certificates" ON public.certificate_requests
        FOR INSERT TO authenticated
        WITH CHECK (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())
    $p$;
  END IF;
END $$;

-- Video analytics: keep own insert/select if table exists
DO $$ BEGIN
  IF to_regclass('public.video_analytics_events') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Students insert own video analytics events" ON public.video_analytics_events';
    EXECUTE 'DROP POLICY IF EXISTS "Students select own video analytics events" ON public.video_analytics_events';
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='video_analytics_events' AND column_name='student_id'
    ) THEN
      EXECUTE $p$
        CREATE POLICY "Students insert own video analytics events" ON public.video_analytics_events
          FOR INSERT TO authenticated
          WITH CHECK (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())
      $p$;
      EXECUTE $p$
        CREATE POLICY "Students select own video analytics events" ON public.video_analytics_events
          FOR SELECT TO authenticated
          USING (student_id IN (SELECT public.current_student_ids()) OR public.is_admin())
      $p$;
    END IF;
  END IF;
END $$;

-- -------------------------------------------------------------------------
-- 6) Catch-all: any remaining public table with RLS but ZERO policies
--    gets admin-only access (service_role backend still works)
-- -------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  policy_count int;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = true
  LOOP
    SELECT COUNT(*) INTO policy_count
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = r.table_name;

    IF policy_count = 0 THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())',
        'Admins manage ' || r.table_name, r.table_name
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

-- =========================================================================
-- VERIFY (optional): tables still missing RLS should return 0 rows
-- =========================================================================
SELECT c.relname AS table_without_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = false
ORDER BY 1;
