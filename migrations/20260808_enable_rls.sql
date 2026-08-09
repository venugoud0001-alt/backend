-- =========================================================================
-- INTERNNETRA SECURITY MIGRATION: ROW LEVEL SECURITY (RLS) POLICIES
-- =========================================================================

-- 1. ENABLE RLS ON ALL TABLES
ALTER TABLE IF EXISTS public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.profiles ENABLE ROW LEVEL SECURITY;

-- 2. COURSES & BATCHES: PUBLIC READ ACCESS FOR PUBLISHED/ACTIVE CATALOG
DROP POLICY IF EXISTS "Public can view published courses" ON public.courses;
CREATE POLICY "Public can view published courses" ON public.courses
  FOR SELECT USING (status = 'PUBLISHED' OR status = 'ACTIVE');

DROP POLICY IF EXISTS "Public can view active batches" ON public.batches;
CREATE POLICY "Public can view active batches" ON public.batches
  FOR SELECT USING (status = 'ACTIVE' OR status = 'FULL');

-- 3. PROFILES: USERS CAN READ/UPDATE THEIR OWN PROFILE ONLY
DROP POLICY IF EXISTS "Users view own profile" ON public.profiles;
CREATE POLICY "Users view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
CREATE POLICY "Users update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- 4. STUDENTS: READ/UPDATE OWN STUDENT ROW BY EMAIL/ID
DROP POLICY IF EXISTS "Students view own record" ON public.students;
CREATE POLICY "Students view own record" ON public.students
  FOR SELECT USING (auth.jwt() ->> 'email' = email OR auth.uid() = id);

-- 5. ENROLLMENTS: STUDENTS CAN READ THEIR OWN ENROLLMENTS
DROP POLICY IF EXISTS "Students view own enrollments" ON public.enrollments;
CREATE POLICY "Students view own enrollments" ON public.enrollments
  FOR SELECT USING (
    student_id IN (SELECT id FROM public.students WHERE email = auth.jwt() ->> 'email' OR id = auth.uid())
  );

-- 6. PAYMENTS & ORDERS: STUDENTS CAN READ THEIR OWN PAYMENTS & ORDERS
DROP POLICY IF EXISTS "Students view own payments" ON public.payments;
CREATE POLICY "Students view own payments" ON public.payments
  FOR SELECT USING (
    student_id IN (SELECT id FROM public.students WHERE email = auth.jwt() ->> 'email' OR id = auth.uid())
    OR email = auth.jwt() ->> 'email'
  );

DROP POLICY IF EXISTS "Students view own orders" ON public.orders;
CREATE POLICY "Students view own orders" ON public.orders
  FOR SELECT USING (
    student_id IN (SELECT id FROM public.students WHERE email = auth.jwt() ->> 'email' OR id = auth.uid())
  );

-- Note: Express Backend uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS safely after server-side authorization check.
