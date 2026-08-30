-- =========================================================================
-- INTERNNETRA LMS ARCHITECTURE V2 - COUPONS & DISCOUNTS MIGRATION
-- Independent pricing layer. Does NOT mutate canonical course prices or installments.
-- =========================================================================

-- 1. COUPONS TABLE
CREATE TABLE IF NOT EXISTS public.coupons (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  discount_type VARCHAR(50) NOT NULL DEFAULT 'PERCENTAGE',
  discount_value NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  starts_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  usage_limit INT,
  used_count INT DEFAULT 0,
  per_user_limit INT DEFAULT 1,
  minimum_course_amount NUMERIC(12, 2) DEFAULT 0.00,
  maximum_discount_amount NUMERIC(12, 2),
  applicability VARCHAR(50) NOT NULL DEFAULT 'GLOBAL',
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  department_id UUID REFERENCES public.departments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Constraints
ALTER TABLE public.coupons DROP CONSTRAINT IF EXISTS chk_coupons_discount_type;
ALTER TABLE public.coupons ADD CONSTRAINT chk_coupons_discount_type CHECK (discount_type IN ('PERCENTAGE', 'FIXED_AMOUNT'));

ALTER TABLE public.coupons DROP CONSTRAINT IF EXISTS chk_coupons_discount_value_positive;
ALTER TABLE public.coupons ADD CONSTRAINT chk_coupons_discount_value_positive CHECK (discount_value >= 0);

ALTER TABLE public.coupons DROP CONSTRAINT IF EXISTS chk_coupons_status;
ALTER TABLE public.coupons ADD CONSTRAINT chk_coupons_status CHECK (status IN ('ACTIVE', 'DISABLED', 'EXPIRED', 'SCHEDULED', 'EXHAUSTED'));

ALTER TABLE public.coupons DROP CONSTRAINT IF EXISTS chk_coupons_applicability;
ALTER TABLE public.coupons ADD CONSTRAINT chk_coupons_applicability CHECK (applicability IN ('GLOBAL', 'COURSE', 'DEPARTMENT'));

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_coupons_code ON public.coupons(code);
CREATE INDEX IF NOT EXISTS idx_coupons_status ON public.coupons(status);
CREATE INDEX IF NOT EXISTS idx_coupons_course_id ON public.coupons(course_id);
CREATE INDEX IF NOT EXISTS idx_coupons_department_id ON public.coupons(department_id);
