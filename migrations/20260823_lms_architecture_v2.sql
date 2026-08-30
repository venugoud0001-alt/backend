-- =========================================================================
-- INTERNNETRA LMS ARCHITECTURE V2 MIGRATION
-- Final Business Model: Departments -> Courses -> Modules -> Lessons -> Topics
-- Pricing Plans -> Installments, Price Snapshots, Storage Abstraction
-- =========================================================================

-- 1. DEPARTMENTS TABLE
CREATE TABLE IF NOT EXISTS public.departments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  image_url TEXT,
  thumbnail_url TEXT,
  display_order INT DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.departments DROP CONSTRAINT IF EXISTS chk_departments_status_enum;
ALTER TABLE public.departments ADD CONSTRAINT chk_departments_status_enum CHECK (status IN ('ACTIVE', 'INACTIVE'));

CREATE INDEX IF NOT EXISTS idx_departments_slug ON public.departments(slug);
CREATE INDEX IF NOT EXISTS idx_departments_status_order ON public.departments(status, display_order);

-- 2. COURSES TABLE
-- Ensure department_id exists and references departments
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS short_description TEXT;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS level VARCHAR(100) DEFAULT 'Beginner to Advanced';
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS duration VARCHAR(100) DEFAULT '8 Weeks';
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS language VARCHAR(50) DEFAULT 'English';
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS display_order INT DEFAULT 0;

ALTER TABLE public.courses DROP CONSTRAINT IF EXISTS chk_courses_status_enum_v2;
ALTER TABLE public.courses ADD CONSTRAINT chk_courses_status_enum_v2 CHECK (status IN ('DRAFT', 'PUBLISHED', 'INACTIVE', 'ACTIVE', 'ARCHIVED'));

CREATE INDEX IF NOT EXISTS idx_courses_department_id ON public.courses(department_id);
CREATE INDEX IF NOT EXISTS idx_courses_slug ON public.courses(slug);
CREATE INDEX IF NOT EXISTS idx_courses_status ON public.courses(status);

-- 3. MODULES TABLE
CREATE TABLE IF NOT EXISTS public.modules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  display_order INT DEFAULT 0,
  duration_hours NUMERIC(6, 2) DEFAULT 2.5,
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.modules DROP CONSTRAINT IF EXISTS chk_modules_status_enum;
ALTER TABLE public.modules ADD CONSTRAINT chk_modules_status_enum CHECK (status IN ('ACTIVE', 'INACTIVE', 'DRAFT', 'PUBLISHED'));

CREATE INDEX IF NOT EXISTS idx_modules_course_id_order ON public.modules(course_id, display_order);

-- 4. LESSONS TABLE (LEARNING CONTENT & VIDEOS)
CREATE TABLE IF NOT EXISTS public.lessons (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  module_id UUID NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  storage_provider VARCHAR(50) DEFAULT 'SUPABASE',
  storage_key TEXT,
  video_url TEXT,
  duration_seconds INT DEFAULT 0,
  display_order INT DEFAULT 0,
  is_preview BOOLEAN DEFAULT FALSE,
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.lessons DROP CONSTRAINT IF EXISTS chk_lessons_status_enum;
ALTER TABLE public.lessons ADD CONSTRAINT chk_lessons_status_enum CHECK (status IN ('ACTIVE', 'INACTIVE', 'DRAFT', 'PUBLISHED'));

ALTER TABLE public.lessons DROP CONSTRAINT IF EXISTS chk_lessons_storage_provider_enum;
ALTER TABLE public.lessons ADD CONSTRAINT chk_lessons_storage_provider_enum CHECK (storage_provider IN ('SUPABASE', 'AWS_S3', 'CLOUDFRONT', 'LOCAL', 'EXTERNAL'));

CREATE INDEX IF NOT EXISTS idx_lessons_module_id_order ON public.lessons(module_id, display_order);

-- 5. TOPICS TABLE (BELONGS TO LESSON / VIDEO)
CREATE TABLE IF NOT EXISTS public.topics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lesson_id UUID NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_topics_lesson_id_order ON public.topics(lesson_id, display_order);

-- Also support alias/view or existing lesson_topics table for backwards compatibility
CREATE TABLE IF NOT EXISTS public.lesson_topics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lesson_id UUID NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. PRICING PLANS TABLE (INDEPENDENT PER COURSE)
CREATE TABLE IF NOT EXISTS public.pricing_plans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  payment_mode VARCHAR(50) NOT NULL DEFAULT 'FULL',
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.pricing_plans DROP CONSTRAINT IF EXISTS chk_pricing_plans_payment_mode;
ALTER TABLE public.pricing_plans ADD CONSTRAINT chk_pricing_plans_payment_mode CHECK (payment_mode IN ('FULL', 'INSTALLMENT'));

ALTER TABLE public.pricing_plans DROP CONSTRAINT IF EXISTS chk_pricing_plans_total_amount_positive;
ALTER TABLE public.pricing_plans ADD CONSTRAINT chk_pricing_plans_total_amount_positive CHECK (total_amount >= 0);

ALTER TABLE public.pricing_plans DROP CONSTRAINT IF EXISTS chk_pricing_plans_status;
ALTER TABLE public.pricing_plans ADD CONSTRAINT chk_pricing_plans_status CHECK (status IN ('ACTIVE', 'INACTIVE'));

CREATE INDEX IF NOT EXISTS idx_pricing_plans_course_id ON public.pricing_plans(course_id, status);

-- 7. INSTALLMENTS TABLE (FLEXIBLE N-PHASE PLANS)
CREATE TABLE IF NOT EXISTS public.installments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pricing_plan_id UUID NOT NULL REFERENCES public.pricing_plans(id) ON DELETE CASCADE,
  installment_number INT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  due_after_days INT DEFAULT 30,
  due_date DATE,
  title VARCHAR(255),
  description TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.installments DROP CONSTRAINT IF EXISTS chk_installments_number_positive;
ALTER TABLE public.installments ADD CONSTRAINT chk_installments_number_positive CHECK (installment_number > 0);

ALTER TABLE public.installments DROP CONSTRAINT IF EXISTS chk_installments_amount_positive;
ALTER TABLE public.installments ADD CONSTRAINT chk_installments_amount_positive CHECK (amount >= 0);

ALTER TABLE public.installments DROP CONSTRAINT IF EXISTS uq_plan_installment_number;
ALTER TABLE public.installments ADD CONSTRAINT uq_plan_installment_number UNIQUE (pricing_plan_id, installment_number);

CREATE INDEX IF NOT EXISTS idx_installments_plan_id_num ON public.installments(pricing_plan_id, installment_number);

-- 8. ENROLLMENT HISTORICAL SNAPSHOT ENHANCEMENTS
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS course_name_snapshot TEXT;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS pricing_plan_id UUID REFERENCES public.pricing_plans(id) ON DELETE SET NULL;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'INR';

-- Ensure foreign keys and indices
CREATE INDEX IF NOT EXISTS idx_enrollments_pricing_plan_id ON public.enrollments(pricing_plan_id);
